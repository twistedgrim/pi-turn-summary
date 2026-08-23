#!/usr/bin/env bash
set -euo pipefail

# Config: summarize almost immediately so `pi -p` (which exits when the agent
# settles) still has a chance to run the summary before the process ends.
mkdir -p /root/.pi/agent
cat > /root/.pi/agent/turn-summary.json <<JSON
{
  "delayMs": 1,
  "notify": false,
  "provider": {
    "name": "turn-summary-local",
    "baseUrl": "http://localhost:8000/v1",
    "apiKey": "lm-studio",
    "api": "openai-completions",
    "modelId": "gemma-4-12b-it-mlx"
  }
}
JSON

node /app/test/mock-server.mjs & 
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT

# Wait for the mock to come up.
for i in $(seq 1 50); do
  curl -sf http://localhost:8000/v1/models >/dev/null 2>&1 && break
  sleep 0.1
done

echo "=== running pi -p ==="
pi -p --provider turn-summary-local --model gemma-4-12b-it-mlx -e /app/extensions/turn-summary.ts "Reply with exactly: PONG"
echo "=== pi exit: $? ==="

# Small grace period for the summary request (should be near-instant, but allow
# the event loop to drain).
sleep 2
curl -sf http://localhost:8000/v1/models >/dev/null 2>&1 || true
