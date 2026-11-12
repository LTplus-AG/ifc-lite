#!/usr/bin/env bash
# #9523 browser evidence: Chromium Local Network Access and Firefox, against the built viewer served on a
# public-looking https origin and the real `ifc-lite-mcp --bridge`. Run from a repository root.
#   bash scripts/browser-evidence/9523/run.sh [outDir]      (builds the viewer and @ifc-lite/mcp first)
#   SKIP_BUILD=1 REPO_BUILT=/other/built/checkout bash ...   (iterate on an already built checkout)
# Also runs the socket-only probes (lna-socket-probe.mjs, ff-socket-probe.mjs). Prints every report and the
# screenshots as base64 so a fleet log carries the full evidence.
set -euo pipefail
R=$PWD
HERE="$R/scripts/browser-evidence/9523"
B=${REPO_BUILT:-$R}
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT"
W=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 1; for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done; rm -rf "$W"; }
trap cleanup EXIT
echo "source commit: $(git rev-parse HEAD) built from: $B host: $(hostname) node: $(node -v) out: $OUT"
if [ -z "${SKIP_BUILD:-}" ]; then
  pnpm install --frozen-lockfile --prefer-offline >/dev/null
  pnpm exec turbo build --filter=@ifc-lite/viewer --filter=@ifc-lite/mcp --output-logs=errors-only
fi
(cd "$B" && { pnpm exec playwright install chromium firefox >/dev/null 2>&1 || pnpm exec playwright install chromium firefox; })
HOST=ifclite.test
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST" \
  -keyout "$W/key.pem" -out "$W/cert.pem" 2>/dev/null
VPORT=$((41000 + RANDOM % 2000)); HPORT=$((43000 + RANDOM % 2000))
(cd "$B/apps/viewer" && exec pnpm exec vite preview --port "$VPORT" --strictPort) > "$OUT/preview.log" 2>&1 & PIDS+=($!)
node "$HERE/https-front.mjs" "$HPORT" "$W/cert.pem" "$W/key.pem" "$HERE" "http://localhost:$VPORT" > "$OUT/front.log" 2>&1 & PIDS+=($!)
for i in $(seq 150); do curl -skf --resolve "$HOST:$HPORT:127.0.0.1" "https://$HOST:$HPORT/" >/dev/null && break; sleep 0.2; done
CLI="$B/packages/mcp/dist/cli.js"
FIXTURE="$B/apps/viewer/public/samples/building-architecture.ifc"

# Socket-only probes: one bridge, no pairing (they only observe open/close).
(sleep 400 | node "$CLI" --bridge --bridge-port 0 --bridge-viewer-url "https://$HOST:$HPORT" > /dev/null 2> "$OUT/probe-bridge.log") & PIDS+=($!)
for i in $(seq 100); do grep -q "listening on ws://127.0.0.1:" "$OUT/probe-bridge.log" 2>/dev/null && break; sleep 0.1; done
BPORT=$(sed -n 's/.*listening on ws:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$OUT/probe-bridge.log" | head -1)
rc=0
timeout 200 node "$HERE/lna-socket-probe.mjs" "$B" "$HOST" "$HPORT" "$BPORT" "$OUT" > "$OUT/lna-socket-probe.log" 2>&1 || rc=$?
timeout 300 node "$HERE/ff-socket-probe.mjs" "$B" "$HOST" "$HPORT" "$BPORT" "$OUT" > "$OUT/ff-socket-probe.log" 2>&1 || rc=$?
sed -i 's/code=[A-Z0-9-]*/code=<redacted>/g; s/one-time code [A-Z0-9-]*/one-time code <redacted>/' "$OUT/probe-bridge.log"

# Full viewer runs, one bridge + driver per browser.
for browser in chromium firefox; do
  D="$OUT/$browser"; mkdir -p "$D"
  node "$HERE/driver.mjs" "$CLI" "https://$HOST:$HPORT" "$D" > "$D/driver.log" 2>&1 & DP=$!; PIDS+=($DP)
  timeout 900 node "$HERE/browser-run.mjs" "$B" "$browser" "$HOST" "$HPORT" "$FIXTURE" "$D" || rc=$?
  for i in $(seq 50); do kill -0 "$DP" 2>/dev/null || break; sleep 0.2; done
done

for f in "$OUT"/lna-socket-probe.json "$OUT"/ff-socket-probe.json "$OUT"/*/*-report.json "$OUT"/*/driver-summary.json; do
  [ -f "$f" ] && { echo "=== $f"; cat "$f"; echo; }
done
for f in "$OUT"/*/transcript.jsonl; do echo "=== $f"; cat "$f"; done
if [ -n "${PRINT_PNG:-}" ]; then
  for f in "$OUT"/*/*.png; do echo "=== BEGIN PNG $f"; base64 -w 0 "$f"; echo; echo "=== END PNG $f"; done
fi
echo "=== exit $rc"
exit $rc
