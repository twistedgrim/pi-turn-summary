import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderModelConfig,
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
// Follows the pi extension guide: async factory discovers and registers local
// models at startup (visible to `pi --list-models`); timers are only created
// inside event handlers and cleaned up on session_shutdown.
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
  provider: {
    name: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    modelId: string;
    contextWindow: number;
    maxTokens: number;
  };
}

const DEFAULT_CONFIG: TurnSummaryConfig = {
  enabled: true,
  delayMs: 10_000,
  minMessages: 2,
  notify: true,
  provider: {
    name: "turn-summary-local",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    api: "openai-completions",
    modelId: "gemma-4-12b-it-mlx",
    contextWindow: 131072,
    maxTokens: 4096,
  },
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
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        provider: { ...DEFAULT_CONFIG.provider, ...(parsed.provider ?? {}) },
      };
    } catch {
      // try the next candidate, then fall back to defaults
    }
  }
  return DEFAULT_CONFIG;
};

interface SummaryState {
  lastMessageCount: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  abort: AbortController | null;
  history: SummaryRecord[];
  maxHistory: number;
}

export default async function (pi: ExtensionAPI) {
  // Config is loaded once at startup. No ctx in the factory, so use cwd.
  const cfg = loadConfig(process.cwd());
  let primaryModelId = cfg.provider.modelId;

  const state: SummaryState = {
    lastMessageCount: -1,
    timer: null,
    inFlight: false,
    abort: null,
    history: [],
    maxHistory: 20,
  };

  const toModel = (id: string, name: string): ProviderModelConfig => ({
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.provider.contextWindow,
    maxTokens: cfg.provider.maxTokens,
  });

  const registerProvider = (models: ProviderModelConfig[]): void => {
    pi.registerProvider(cfg.provider.name, {
      name: "Pi Turn Summary (local)",
      baseUrl: cfg.provider.baseUrl,
      apiKey: cfg.provider.apiKey,
      api: cfg.provider.api,
      models,
    });
  };

  // Guide pattern: discover the local server's models at startup so the
  // provider is available immediately and shows up in `pi --list-models`.
  // Falls back to the configured single model when the server is unreachable.
  try {
    const res = await fetch(`${cfg.provider.baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const payload = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => !!id);
      if (ids.length > 0) {
        primaryModelId = ids.includes(cfg.provider.modelId) ? cfg.provider.modelId : ids[0];
        registerProvider(ids.map((id) => toModel(id, id)));
      } else {
        registerProvider([toModel(cfg.provider.modelId, "Turn summary model")]);
      }
    } else {
      registerProvider([toModel(cfg.provider.modelId, "Turn summary model")]);
    }
  } catch {
    registerProvider([toModel(cfg.provider.modelId, "Turn summary model")]);
  }

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
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(async () => {
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

        const model = ctx.modelRegistry.find(cfg.provider.name, primaryModelId);
        if (!model) {
          if (ctx.hasUI) ctx.ui.notify(`turn-summary: model ${cfg.provider.name}/${cfg.provider.modelId} not found`, "warning");
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
          state.history.unshift({
            sessionId: ctx.sessionManager.getSessionId(),
            ts: nowIso(),
            text: summary,
          });
          if (state.history.length > state.maxHistory) state.history.length = state.maxHistory;
          if (ctx.hasUI && cfg.notify) {
            ctx.ui.notify(summary.split("\n")[0].slice(0, 160), "info");
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
    }, cfg.delayMs);
  });

  // A new turn invalidates any pending summary — it would otherwise summarize
  // stale context mid-answer. Aborts an in-flight summary, mirroring how
  // Claude Code's AgentSummary stop() cancels its background fork.
  pi.on("turn_start", async (_event: TurnStartEvent, _ctx: ExtensionContext) => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
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

  // Clean up session-scoped resources per the extension guide.
  pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.inFlight && state.abort) state.abort.abort();
  });
}