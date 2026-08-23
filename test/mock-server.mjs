// Mock OpenAI-compatible server for e2e tests.
// Serves /v1/models, /v1/completions and /v1/chat/completions (plain + SSE).
// Logs every request as JSONL to $MOCK_LOG.
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.MOCK_PORT ?? 8000);
const LOG = process.env.MOCK_LOG ?? "/tmp/mock-requests.jsonl";
const MODEL = process.env.MOCK_MODEL ?? "gemma-4-12b-it-mlx";
const MARKER = "Describe the most recent action";
let seq = 0;

const log = (o) => {
  try { fs.appendFileSync(LOG, JSON.stringify(o) + "\n"); } catch {}
};
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  log({ ts: new Date().toISOString(), path, body });

  res.setHeader("Content-Type", "application/json");

  if (path === "/v1/models") {
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }

  const isChat = path.endsWith("/chat/completions");
  const prompt =
    typeof body.prompt === "string"
      ? body.prompt
      : Array.isArray(body.messages)
        ? body.messages.map((m) => m.content).join("\n")
        : "";
  const isSummary = prompt.includes(MARKER);
  const reply = isSummary ? "Added turn-summary e2e test" : "PONG";
  log({ path, prompt, isSummary, reply });

  const id = "mock-" + ++seq;
  const send = (chunk, done) => {
    if (body.stream) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (done) { res.write("data: [DONE]\n\n"); res.end(); }
    } else {
      res.end(JSON.stringify(chunk));
    }
  };

  if (isChat) {
    if (body.stream) {
      send({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] });
      send({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply } }] });
      send({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, true);
    } else {
      send({ id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
  } else if (body.stream) {
    send({ id, object: "text_completion", choices: [{ index: 0, text: reply }] });
    send({ id, object: "text_completion", choices: [{ index: 0, text: "", finish_reason: "stop" }] }, true);
  } else {
    send({ id, object: "text_completion", choices: [{ index: 0, text: reply, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
}).listen(PORT, () => console.log(`[mock] listening on :${PORT} log=${LOG}`));
