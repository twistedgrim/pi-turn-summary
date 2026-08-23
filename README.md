# pi-turn-summary

Automatically summarizes each completed agent turn in [pi](https://github.com/earendil-works/pi) using a **local OpenAI-compatible model**, then shows a quiet notification with the summary. Summaries are kept **in memory only** (last 20, per session) — nothing is written to disk. Replay the latest with `/turn-summary`.

The goal: after the agent finishes its turn and goes idle (waiting for your next prompt), you get a Claude-style one-line record of *what it just did* — without scrolling the transcript.

## How it works

- Hooks **`agent_settled`** — fires when pi is idle and no retry/compaction/follow-up is left, i.e. exactly when it's your turn again.
- Waits **10s** (configurable) so rapid follow-ups don't spam summaries; a new `turn_start` cancels a pending or in-flight summary.
- Extracts the user/assistant text from the current branch, sends it to a self-contained OpenAI-compatible provider (defaults to a local LM Studio endpoint), keeps the summary in memory, and notifies you quietly.
- `/turn-summary` replays the most recent summary for the current session.

Ephemeral by design: summaries live in memory and are discarded on exit. The session transcript itself is the durable record. Inspired by [Claude Code's AgentSummary](https://code.claude.com/docs/en/agent-view) — same "side model, no tool use, one short summary" idea, but event-driven (end of turn) instead of a 30s polling loop.

## Install

Point pi at this package (add to `~/.pi/agent/settings.json`):

```json
{
  "extensions": ["/absolute/path/to/pi-turn-summary/extensions/turn-summary.ts"]
}
```

or symlink it into the auto-discovered global extension directory:

```bash
ln -s ~/Github/pi-turn-summary/extensions/turn-summary.ts ~/.pi/agent/extensions/turn-summary.ts
```

Restart pi or run `/reload` — the extension registers its own local provider at first use.

## Configuration

Defaults work out of the box against LM Studio at `http://localhost:1234/v1` (OpenAI-compatible API). To override, create `turn-summary.json` in the project root or `~/.pi/agent/turn-summary.json`:

```json
{
  "enabled": true,
  "delayMs": 10000,
  "minMessages": 2,
  "notify": true,
  "provider": {
    "name": "turn-summary-local",
    "baseUrl": "http://localhost:1234/v1",
    "apiKey": "lm-studio",
    "api": "openai-completions",
    "modelId": "gemma-4-12b-it-mlx",
    "contextWindow": 131072,
    "maxTokens": 4096
  }
}
```

- `delayMs` — ms to wait after `agent_settled` before summarizing.
- `minMessages` — skip tiny conversations.
- `notify` — quiet `info`-level TUI notification with the one-line summary; set `false` to suppress.
- `provider` — any OpenAI-compatible endpoint: Ollama (`http://localhost:11434/v1`), vLLM, etc.

Summaries are ephemeral (memory only, last ~20 per session, `/turn-summary` to replay). Config is read once at first turn; restart or `/reload` after changing it.

## Development

```bash
npm install
npm run typecheck
```

## Publish later

This is a `pi-package` (see `package.json` `pi.extensions` field) so it's publishable to npm or the [pi package gallery](https://pi.dev/packages) later. Add `video`/`image` metadata when the time comes.