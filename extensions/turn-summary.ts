import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnStartEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// GitHub: https://github.com/jamescobb/pi-turn-summary
//
// Summarizes the current conversation shortly after the agent finishes its
// turn (fires on `agent_settled` — pi is idle and waiting for the next user
// turn), using a locally running OpenAI-compatible model. Fires one quiet TUI
// notification and keeps the last few summaries in memory (ephemeral —
// nothing is written to disk). Use `/turn-summary` to replay the latest one.
//
// Uses an existing pi provider (default: lmstudio) — no custom provider
// registration needed. Override via providerName/modelId in config.
// Timers are only created inside event handlers and cleaned up on
// session_shutdown.
//
// Configuration lives in `turn-summary.json` next to the project or in
// `~/.pi/agent/turn-summary.json`. See README.md.
// ---------------------------------------------------------------------------

type ContentBlock = {
  type?: string;
  text?: string;
};

type SessionEntry = {
  type: string;
  message?: { role?: string; content?: unknown };
};

interface TurnSummaryConfig {
  enabled: boolean;
  delayMs: number;
  minMessages: number;
  notify: boolean;
  /** Existing pi provider to use for summaries. Omit to use the current model's provider. */
  providerName?: string;
  /** Model id within that provider. Omit to use the current model's id. */
  modelId?: string;
  /** Optional: override endpoint for the shutdown-flush path (raw fetch). */
  baseUrl?: string;
  apiKey?: string;
}

const DEFAULT_CONFIG: TurnSummaryConfig = {
  enabled: true,
  delayMs: 10_000,
  minMessages: 2,
  notify: true,
};

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const extractTextParts = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts;
};

const buildConversationText = (entries: SessionEntry[]): string => {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextParts(entry.message.content)
      .join("\n")
      .trim();
    if (!text) continue;
    sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return sections.join("\n\n");
};

const buildSummaryPrompt = (conversationText: string): string =>
  [
    "Describe the most recent action from this conversation in one short line, present tense (-ing), naming the concrete file, function, or result. Not a branch name.",
    "",
    "Good: \"Adding retry logic to fetchUser in auth.ts\"",
    "Good: \"Running auth module tests\"",
    "Good: \"result: menu, options, and credits done\"",
    "Bad (past tense): \"Analyzed the branch diff\"",
    "Bad (too vague): \"Investigating the issue\"",
    "Bad (too long): more than one line",
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
  ].join("\n");

const nowIso = (): string => new Date().toISOString();

interface SummaryRecord {
  sessionId: string;
  ts: string;
  text: string;
}

const loadConfig = (cwd: string): TurnSummaryConfig => {
  const candidates = [
    join(cwd, "turn-summary.json"),
    expandHome("~/.pi/agent/turn-summary.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<TurnSummaryConfig>;
      // Backward compat: accept old "provider.name" / "provider.modelId" shape
      const oldProvider = (parsed as Record<string, unknown>).provider as
        { name?: string; modelId?: string; baseUrl?: string; apiKey?: string } | undefined;
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        providerName: parsed.providerName ?? oldProvider?.name ?? DEFAULT_CONFIG.providerName,
        modelId: parsed.modelId ?? oldProvider?.modelId ?? DEFAULT_CONFIG.modelId,
        baseUrl: parsed.baseUrl ?? oldProvider?.baseUrl,
        apiKey: parsed.apiKey ?? oldProvider?.apiKey,
      };
    } catch {
      // try the next candidate, then fall back to defaults
    }
  }
  return DEFAULT_CONFIG;
};

interface SummaryState {
  lastMessageCount: number;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null;
  inFlight: boolean;
  abort: AbortController | null;
  history: SummaryRecord[];
  maxHistory: number;
  pendingText: string | undefined;
}

export default async function (pi: ExtensionAPI) {
  const cfg = loadConfig(process.cwd());

  // Lazily resolved from the current model on first summary.
  let resolvedProvider: string | undefined;
  let resolvedModelId: string | undefined;

  const resolveModel = (ctx: ExtensionContext): { provider: string; modelId: string } | undefined => {
    if (cfg.providerName && cfg.modelId) {
      return { provider: cfg.providerName, modelId: cfg.modelId };
    }
    if (resolvedProvider && resolvedModelId) {
      return { provider: resolvedProvider, modelId: resolvedModelId };
    }
    const current = ctx.model;
    if (!current) return undefined;
    resolvedProvider = cfg.providerName ?? current.provider;
    resolvedModelId = cfg.modelId ?? current.id;
    return { provider: resolvedProvider, modelId: resolvedModelId };
  };

  const state: SummaryState = {
    lastMessageCount: -1,
    timer: null,
    inFlight: false,
    abort: null,
    history: [],
    maxHistory: 20,
    pendingText: undefined,
  };

  const clearPending = (): void => {
    if (state.timer) {
      clearTimeout(state.timer as ReturnType<typeof setTimeout>);
      clearImmediate(state.timer as ReturnType<typeof setImmediate>);
      state.timer = null;
    }
  };
  const runSummary = async (ctx: ExtensionContext): Promise<void> => {
    state.timer = null;
    if (state.inFlight) return;
    if (!ctx.isIdle()) return; // a new turn already started

    state.inFlight = true;
    state.abort = new AbortController();
    try {
      const fresh = ctx.sessionManager.getBranch() as SessionEntry[];
      if (fresh.length <= state.lastMessageCount) return;

      const conversationText = buildConversationText(fresh);
      if (!conversationText.trim()) return;

      if (ctx.hasUI && cfg.notify) {
        ctx.ui.notify("Summarizing turn…", "info");
      }

      const resolved = resolveModel(ctx);
      if (!resolved) {
        if (ctx.hasUI) ctx.ui.notify("turn-summary: no active model to summarize with", "warning");
        return;
      }
      const model = ctx.modelRegistry.find(resolved.provider, resolved.modelId);
      if (!model) {
        if (ctx.hasUI) ctx.ui.notify(`turn-summary: model ${resolved.provider}/${resolved.modelId} not found`, "warning");
        return;
      }

      const response = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
              timestamp: Date.now(),
            },
          ],
        },
        { sessionId: randomUUID(), cacheRetention: "none", signal: state.abort?.signal },
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (summary) {
        const prefixed = `\u2192 ${summary}`;
        state.history.unshift({
          sessionId: ctx.sessionManager.getSessionId(),
          ts: nowIso(),
          text: prefixed,
        });
        if (state.history.length > state.maxHistory) state.history.length = state.maxHistory;
        if (ctx.hasUI && cfg.notify) {
          ctx.ui.notify(prefixed.split("\n")[0].slice(0, 160), "info");
        }
      }

      state.lastMessageCount = fresh.length;
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError") && ctx.hasUI) {
        ctx.ui.notify(`turn-summary failed: ${(err as Error).message}`, "warning");
      }
    } finally {
      state.inFlight = false;
      state.abort = null;
    }
  };

  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    if (!cfg.enabled) return;

    const entries = ctx.sessionManager.getBranch() as SessionEntry[];
    const count = entries.length;

    if (count < cfg.minMessages) {
      state.lastMessageCount = count;
      return;
    }
    // Nothing new since the last summary.
    if (state.lastMessageCount >= count) return;
    clearPending();
    state.pendingText = buildConversationText(entries);

    // delayMs <= 0 summarizes immediately (used by tests/print mode where the
    // process may exit before a delay elapses).
    state.timer =
      cfg.delayMs <= 0
        ? setImmediate(() => runSummary(ctx))
        : setTimeout(() => runSummary(ctx), cfg.delayMs);
  });

  // A new turn invalidates any pending summary — it would otherwise summarize
  // stale context mid-answer. Aborts an in-flight summary, mirroring how
  // Claude Code's AgentSummary stop() cancels its background fork.
  pi.on("turn_start", async (_event: TurnStartEvent, _ctx: ExtensionContext) => {
    clearPending();
    if (state.inFlight && state.abort) state.abort.abort();
  });

  // Replay the latest summary on demand — ephemeral, lives only in memory.
  pi.registerCommand("turn-summary", {
    description: "Show the latest turn summary for this session",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const latest = state.history.find((h) => h.sessionId === ctx.sessionManager.getSessionId());
      if (!latest) {
        if (ctx.hasUI) ctx.ui.notify("No turn summary recorded yet in this session", "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(latest.text, "info");
    },
  });

  // Clean up session-scoped resources per the extension guide. In print mode
  // the process exits right after the agent settles, so if a summary is still
  // pending at shutdown, flush it now instead of dropping it.
  // In print mode pi exits right after the agent settles, so if a summary is
  // still pending at shutdown, flush it with a raw request: session_shutdown
  // receives a stale ctx, and pi's model registry is not usable through it.
  pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
    clearPending();
    const text = state.pendingText;
    state.pendingText = undefined;
    if (!text || state.inFlight) return;
    try {
      // Shutdown-flush requires a raw fetch (ctx.modelRegistry is stale).
      // Needs baseUrl + apiKey in config; silently skip if not provided.
      if (!cfg.baseUrl || !resolvedModelId) return;
      const prompt = buildSummaryPrompt(text);
      const url = `${cfg.baseUrl.replace(/\/$/, "")}/completions`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: resolvedModelId,
          prompt,
          max_tokens: 4096,
          temperature: 0.2,
          stream: false,
        }),
      });
      if (res.ok) {
        const payload = (await res.json()) as { choices?: Array<{ text?: string }> };
        const summary = (payload.choices?.[0]?.text ?? "").trim();
        if (summary) {
          const prefixed = `\u2192 ${summary}`;
          state.history.unshift({ sessionId: "", ts: nowIso(), text: prefixed });
          if (state.history.length > state.maxHistory) state.history.length = state.maxHistory;
        }
      }
    } catch {
      // nothing to report into; exit is on its way
    }
  });
}