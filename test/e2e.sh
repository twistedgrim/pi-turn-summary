#!/usr/bin/env bash
# e2e: build a container with pi + the extension + a mock OpenAI-compatible
# server, run pi headless, and assert the turn summary actually fired.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/.out"
IMAGE=pi-turn-summary-e2e

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> building container"
docker build -q -t "$IMAGE" -f "$REPO_ROOT/test/Dockerfile" "$REPO_ROOT"

echo "==> running pi headless inside container"
docker run --rm -e MOCK_LOG=/out/requests.jsonl -v "$OUT:/out" "$IMAGE"

echo "==> asserting"
if ! grep -q '"isSummary":true' "$OUT/requests.jsonl"; then
  echo "FAIL: summary model request not captured"
  cat "$OUT/requests.jsonl"
  exit 1
fi
if ! grep -q '"reply":"PONG"' "$OUT/requests.jsonl"; then
  echo "FAIL: main agent model call (PONG) not captured"
  cat "$OUT/requests.jsonl"
  exit 1
fi

echo "PASS: extension loaded, main agent answered, turn summary fired"
