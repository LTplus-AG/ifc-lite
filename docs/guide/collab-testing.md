# Testing `@ifc-lite/collab` end-to-end

This guide walks you through every layer you can poke at — from
single-line unit tests to "open two Chrome windows and watch the
cursors move." Pick the depth you want; each section is self-contained.

## TL;DR

```sh
# 1. Build everything once
pnpm turbo build --filter=@ifc-lite/collab --filter=@ifc-lite/collab-server

# 2. Run the test suite (175 tests, ~10 seconds)
pnpm --filter @ifc-lite/collab test
pnpm --filter @ifc-lite/collab-server test

# 3. Boot the server + the live two-tab demo
pnpm collab:demo
# then open http://localhost:5174 in TWO browser tabs / windows
```

---

## 1. Run the unit + integration tests

The fastest way to verify everything works.

```sh
pnpm --filter @ifc-lite/collab test
# → 134 tests across schema, ops, snapshot round-trip, undo,
#   conflict detection, conflict UI bridge, federation,
#   blob store + GC, CSG, parametric kernel, determinism,
#   E2E encryption, history sidecar (memory + Automerge),
#   branch tree, GDPR, units, schema migrations, mutations
#   bridge, viewer bridge, perf, render math, latency sim,
#   property-based convergence under random concurrent edits.

pnpm --filter @ifc-lite/collab-server test
# → 41 tests across server boot, two-client sync,
#   disconnect/reconnect, audit log + JSONL, retention,
#   idle unloading, blob route, S3 + Redis persistence,
#   metrics + bucketed histograms, replay-protector wired
#   into the message path, secure-server hardening,
#   path locks, snapshot worker, secure-bundle.
```

Both filter together via Turbo:

```sh
pnpm turbo test --filter=@ifc-lite/collab --filter=@ifc-lite/collab-server
```

---

## 2. Run the perf benchmarks

Asserts the §15 budget on your machine.

```sh
pnpm --filter @ifc-lite/collab exec vitest run test/perf-benchmark.test.ts
```

For the heavy 100k-entity state-vector benchmark:

```sh
COLLAB_BENCH_HEAVY=1 pnpm --filter @ifc-lite/collab exec vitest run test/perf-benchmark.test.ts
```

---

## 3. Smoke-test the server with `curl`

Boot a dev server in one terminal:

```sh
pnpm --filter @ifc-lite/collab-server build
node packages/collab-server/dist/bin.js
# → [collab-server] listening at ws://0.0.0.0:1234 (data: ./.collab-data)
```

Hit each route in another:

```sh
# Healthcheck
curl -s http://localhost:1234/healthz | jq
# → { "ok": true, "rooms": 0 }

# Prometheus metrics
curl -s http://localhost:1234/metrics
# → collab_rooms 0
#   collab_room_peers …
#   collab_updates_total …

# Blob route — content-addressed put / get
echo -n 'hello blob' > /tmp/blob.bin
HASH=$(node -e "
const b = require('fs').readFileSync('/tmp/blob.bin');
let seeds = [0x811c9dc5, 0x84222325, 0xcbf29ce4, 0x100000001];
let out = [];
for (let s = 0; s < 4; s++) {
  let h = seeds[s] >>> 0;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i] ^ ((s + 1) << ((i & 3) * 8));
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  out.push((h >>> 0).toString(16).padStart(8, '0'));
}
process.stdout.write(out.join(''));
")
curl -X PUT --data-binary @/tmp/blob.bin "http://localhost:1234/blobs/$HASH"
curl "http://localhost:1234/blobs/$HASH" | xxd | head -1
curl -X DELETE -i "http://localhost:1234/blobs/$HASH"
```

---

## 4. Live two-tab demo

This is the "open two browser tabs, watch them sync" experience.

```sh
pnpm collab:demo
```

That starts:

- The collab server on `ws://localhost:1234`
- A Vite dev server on `http://localhost:5174`

Open `http://localhost:5174` in **two browser tabs / windows** (or two
machines on the same LAN — point the URL bar at the server's IP).

You will see:

- A canvas that draws boxes and labels.
- The other tab's cursor visibly tracking yours, with a coloured
  arrow + labelled badge — that's `mountPresenceInViewer` and
  `peerVisuals`.
- A "Selection" pill that updates when either tab clicks a box —
  `presence.setSelection(...)` flows through awareness.
- An "Add wall" button that calls `bim.transact()` to push a new
  entity into the Y.Doc. The other tab sees it instantly.
- An "Undo" button scoped to local writes only (the other tab's edits
  are not in your undo stack — that's `Y.UndoManager` with our local
  origin).

Useful things to try:

- **Network blip:** in DevTools → Network, set "Offline" on tab A,
  add a wall, switch back to "Online." Tab B catches up.
- **Conflict:** rename the same wall in both tabs at the same time.
  LWW resolves; the conflict bridge fires `open` then `close`. Watch
  the bottom-right "Conflicts" pill flash.
- **Presence stale:** close one tab — the other shows the badge fade
  to 0.4 opacity within ~10s, then drop entirely.
- **History:** click "Capture snapshot" twice; the history sidecar
  records IFCX entries you can inspect via the "history" panel.

---

## 5. Advanced: simulate latency / packet loss

Use the perf harness to script convergence under hostile networks:

```ts
import { createLatencyChannel } from '@ifc-lite/collab';
import * as Y from 'yjs';

const a = new Y.Doc();
const b = new Y.Doc();
const channel = createLatencyChannel(a, b, {
  baseMs: 200,        // 200ms one-way
  jitterMs: 50,       // ± 50ms jitter
  dropRate: 0.1,      // 10% packet loss
});
channel.initialSync();
a.getMap('m').set('foo', 1);
channel.flushUntil(2000);
console.log(b.getMap('m').get('foo')); // 1, as long as not unlucky on drops
console.log('delivered', channel.delivered(), 'dropped', channel.dropped());
```

---

## 6. Determinism harness (geometry kernel CI)

```ts
import { runDeterminismHarness, DEFAULT_FIXTURES, paramsToMesh } from '@ifc-lite/collab';

const report = runDeterminismHarness(paramsToMesh, DEFAULT_FIXTURES);
console.log(report.results); // [{ name, hash, ok }, …]
```

Drop the `report.results` JSON into your CI as `expected.json` and use
`runDeterminismHarness(kernel, DEFAULT_FIXTURES, expected)` on the next
run; any platform drift gets flagged.

---

## 7. Run the server with TLS + locks + audit

```ts
import {
  startSecureCollabServer,
  JsonlFileAuditSink,
  createPathLockRegistry,
  verifyAgainstPathLocks,
  FilePersistence,
  S3Persistence,
} from '@ifc-lite/collab-server';

const locks = createPathLockRegistry();
locks.add({
  prefix: 'entities/storey-1/',
  label: 'mep-review',
  exemptUserIds: new Set(['admin']),
});

const handle = await startSecureCollabServer({
  port: 4444,
  tls: {
    certPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
    keyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
  },
  persistence: new FilePersistence({ dataDir: '/var/lib/collab' }),
  auditSink: new JsonlFileAuditSink({
    filePath: '/var/log/collab/audit.log',
    rotateAtBytes: 50_000_000,
  }),
  verifyMessage: verifyAgainstPathLocks(locks),
  authenticate: async (token) => {
    // Validate JWT, return { userId, role } or null.
  },
  rateLimit: (principal) =>
    principal.role === 'admin'
      ? { capacity: 1000, refillPerSecond: 200 }
      : { capacity: 200, refillPerSecond: 60 },
  idleUnloadMs: 60 * 60_000,
  compactEvery: 1000,
});
```

---

## 8. Inspect the audit log

```sh
# JSONL format — one entry per line, easy for jq / grep / Loki.
tail -f .collab-data/audit.log | jq
# → { "timestamp": "2026-05-...", "userId": "louis", "role": "editor",
#     "roomId": "project-abc/model.ifcx", "opType": "update",
#     "opHash": "ab12cd34", "detail": { "bytes": 217 } }
```

---

## 9. Where to look when something breaks

| Symptom | Where to look |
|---|---|
| Two clients don't converge | Check `await provider.whenSynced` and `disableBc: true` in tests; `BroadcastChannel` short-circuits in-process |
| Conflict detector silent | `Transaction.changed` is what we observe — confirm both peers actually wrote (use `convergence.test.ts` as a template) |
| Mesh hash drifts | Run `runDeterminismHarness` per platform; if hashes differ, fall back to mesh-blob upload |
| Audit log missing entries | `auditSink` defaults to `noopAuditSink`; pass `MemoryAuditSink` (tests) or `JsonlFileAuditSink` (prod) |
| Server rejects every write | `verifyMessage` / role check / rate-limit hit — check the `reject` audit entries' `detail.reason` |
| Idle rooms stuck loaded | Set `idleUnloadMs`; persistence keeps the durable copy |
