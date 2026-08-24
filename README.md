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

Restart pi or run `/reload` — on startup the extension discovers your local server's models and registers its own OpenAI-compatible provider (visible in `pi --list-models`); if the server is unreachable it falls back to the configured single model.

## Configuration

Defaults work out of the box against LM Studio at `http://localhost:1234/v1` (OpenAI-compatible API). To override, create `turn-summary.json` in the project root or `~/.pi/agent/turn-summary.json`:

```json
{
  "enabled": true,
  "delayMs": 10000,
  "minMessages": 2,
  "notify": true,
  "providerName": "lmstudio",
  "modelId": "gemma-4-12b-it-mlx",
  "baseUrl": "http://localhost:1234/v1",
  "apiKey": "lm-studio"
}
```

- `delayMs` — ms to wait after `agent_settled` before summarizing.
- `minMessages` — skip tiny conversations.
- `notify` — quiet `info`-level TUI notification with the one-line summary; set `false` to suppress.
- `providerName` — existing pi provider to use (default `lmstudio`; also try `litellm`, `crof`, etc.).
- `modelId` — model id within that provider.
- `baseUrl` / `apiKey` — optional; only needed for the shutdown-flush path (print mode). If omitted, shutdown summaries are silently skipped.

Summaries are ephemeral (memory only, last ~20 per session, `/turn-summary` to replay). Config is read once at first turn; restart or `/reload` after changing it.

## Development

```bash
npm install
npm run typecheck
```

## E2E test (containerized)

Builds a container with pi + the extension + a mock OpenAI-compatible server,
runs pi headless (`pi -p`), and asserts that (a) the main agent answered and
(b) the extension fired the turn summary against the model endpoint.

```bash
./test/e2e.sh
```

Requires Docker. The test uses `delayMs: 0` (summarize immediately) so the
summary fires before pi exits, and a shutdown flush for print mode — see
`test/run-in-container.sh` and `test/mock-server.mjs`.

## Publish later

This is a `pi-package` (see `package.json` `pi.extensions` field) so it's publishable to npm or the [pi package gallery](https://pi.dev/packages) later. Add `video`/`image` metadata when the time comes.