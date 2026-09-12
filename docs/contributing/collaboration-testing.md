# Testing `@ifc-lite/collab` end-to-end

This guide walks you through every layer you can poke at — from
single-line unit tests to "open two Chrome windows and watch the
cursors move." Pick the depth you want; each section is self-contained.

!!! tip "Looking for the feature, not the tests?"
    See [Real-Time Collaboration](../guide/collaboration.md) for the user-facing feature
    and [Collaboration Server](../guide/collab-server.md) for self-hosting + configuration.

## TL;DR

```sh
# 1. Build everything once
pnpm turbo build --filter=@ifc-lite/collab --filter=@ifc-lite/collab-server

# 2. Run the test suite
pnpm --filter @ifc-lite/collab test
pnpm --filter @ifc-lite/collab-server test

# 3. Boot the server + the live two-tab demo
pnpm collab:demo
# then open http://localhost:5174 in TWO browser tabs / windows

# 3b. …or exercise the real viewer against the server (two browser profiles):
pnpm --filter @ifc-lite/collab-server build && node packages/collab-server/dist/bin.js &
VITE_COLLAB_ENABLED=true VITE_COLLAB_SERVER_URL=ws://localhost:1234 pnpm --filter viewer dev
# Owner loads a model → Share → copy link → open it in a second profile.
```

---

## 1. Run the unit + integration tests

The fastest way to verify everything works.

```sh
pnpm --filter @ifc-lite/collab test
# → suites covering schema, ops, snapshot round-trip, undo,
#   conflict detection, conflict UI bridge, federation,
#   blob store + GC, CSG, parametric kernel, determinism,
#   E2E encryption, history sidecar (memory + Automerge),
#   branch tree, GDPR, units, schema migrations, mutations
#   bridge, viewer bridge, perf, render math, latency sim,
#   property-based convergence under random concurrent edits.

pnpm --filter @ifc-lite/collab-server test
# → suites covering server boot, two-client sync,
#   room-token auth (mint / revoke / kick), CORS,
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

### Signed tokens (room-token auth)

Boot with a secret to exercise [access control](../guide/collab-server.md#access-control):

```sh
COLLAB_TOKEN_SECRET=dev-secret node packages/collab-server/dist/bin.js
# → … (auth: room-token)

# First mint for a fresh room → creator becomes admin:
ADMIN=$(curl -s -XPOST localhost:1234/collab/token \
  -H 'content-type: application/json' -d '{"roomId":"r1","role":"admin"}' | jq -r .token)

# Admin mints a role-scoped share link:
curl -s -XPOST localhost:1234/collab/token -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"roomId":"r1","role":"editor"}' | jq .role  # "editor"

# Non-admin cannot mint once the room is claimed → 403:
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:1234/collab/token \
  -H 'content-type: application/json' -d '{"roomId":"r1","role":"editor"}'             # 403

# Admin revokes a link / kicks a peer:
curl -s -XPOST localhost:1234/collab/revoke -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d "{\"token\":\"<shareToken>\"}"
curl -s -XPOST localhost:1234/collab/kick -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"roomId":"r1","clientId":123}'
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

### Sharing several models (federation scope)

Exercise the multi-model room with the real viewer (TL;DR step 3b) and two
copies of one file, so that every IFC identity collides on purpose:

1. Owner: load `tests/models/…/AC20-FZK-Haus.ifc` twice (`pnpm fixtures`
   downloads it), apply a different appearance source to the same member in
   each copy, then File → Share. With two models loaded the dialog asks for
   the scope before any room exists; keep **All 2 loaded models**, press
   **Create link**, wait for the upload row ("model 2 of 2") to clear, and
   copy the link.
2. Recipient (second profile): open the link. The hierarchy lists two models
   named after the file, the second suffixed `(2)`; each is selectable on its
   own, each keeps its own texture, and a property edit on one copy lands on
   that copy only.
3. Rejoin: close the recipient, open the link again — still two models.
4. Export on the recipient: the Export dialog lists both `room:*` models
   like any federation. Room models are IFC5, and merged export is STEP-only,
   so export each to its own `.ifcx`. Inside, the entity paths are the model's
   own `/<GlobalId>` paths — the room's slot (`/m0/…`, `/m1/…`) is stripped on
   export, so either copy's file reads like a single-model room export and
   diffs against the other where the copies actually differ (here: the
   member's texture).

What to look for in the doc (DevTools, `session.doc`): the `models` map holds
`m0` and `m1`, and every entity path is `/m0/<GlobalId>` or `/m1/<GlobalId>`.
The recipient's own store keys entities by that room path too (the inspector
shows `/m1/<GlobalId>` as the GlobalId); only the exported file is un-homed.

Known limit: an IFCX seed re-homes `children` / `inherits` references under
the slot, but not path-valued *attributes* of a custom schema — the runtime
cannot tell a path-typed attribute from a string. Such an attribute keeps the
file's unqualified path and dangles on a recipient. STEP seeds are unaffected.

The same journey is automated, in real Chrome against a disposable signed
relay and a private `vite preview` of this checkout's build, both started by
the spec (`tests/e2e/collab/relay.ts`, `preview.ts` — the harness shared with
the #4446 relay acceptance):

```sh
pnpm fixtures                                        # AC20-FZK-Haus.ifc
pnpm turbo build --filter=@ifc-lite/collab-server    # the relay (dist/bin.js)
pnpm --filter @ifc-lite/viewer build                 # the ordinary build, no collab env needed
pnpm test:e2e:collab                                 # Playwright project viewer-collab-e2e
```

The project runs real Google Chrome (`channel: 'chrome'`, headless, WebGPU);
a host with only Playwright's bundled Chromium fails at launch with "chrome
distribution not found" — install Chrome, the spec cannot detect that ahead
of time the way it skips on a missing fixture or build.

`tests/e2e/collab-federation-scope.e2e.spec.ts` loads the fixture twice, paints
the same IfcMember red in copy 1 and blue in copy 2 through the Appearance
workspace, shares "All 2 loaded models", closes the owner, and checks a fresh
guest and a rejoin: two models, each with its own texture, the member picked by
a real canvas click in each copy, no geometry notice, and one slot-free `.ifcx`
per model from the Export dialog. A second test shares "Active model only" and
checks the single-slot guest keeps `globalId === expressId`. The built viewer
is pointed at the relay through the `ifc-lite:collab:server-url` /
`ifc-lite:collab:enabled` `localStorage` overrides, so an unmodified build is
what runs. Set `E2E_EVIDENCE_DIR` to also write the run's JSON and screenshots
to a directory; the recorded run lives in
`docs/architecture/evidence/federation-scope/`. The project is opt-in (CI's
required lanes select `viewer-e2e-ci` by name).

Headless equivalents:
`pnpm --filter viewer exec tsx --import ./src/test/vite-module-hooks.mjs --test src/lib/collab/room-reconstruct.test.ts`
runs the owner → recipient → rejoin sequence on a synthetic two-entity model,
`room-two-copies.ac20.test.ts` beside it on the real fixture (skipped until
`pnpm fixtures` has run), and `owner-seed.frames.test.ts` pins the seed to a
handful of doc updates — the relay's per-connection write budget dropped a
per-entity burst and lost the second copy's geometry before that.

### Relay acceptance for the share invite (#4446)

The invite must not appear before the room — on the relay — holds the model.
`pnpm test:e2e:collab` runs `tests/e2e/collab-share-seed.e2e.spec.ts`
(Playwright project `viewer-collab-e2e`, opt-in, not in CI's default lanes):

```sh
pnpm fixtures                                  # AC20-FZK-Haus.ifc
pnpm turbo build --filter=@ifc-lite/viewer     # the ordinary viewer build — no VITE_COLLAB_* needed
pnpm --filter @ifc-lite/collab-server build
pnpm test:e2e:collab
```

The spec spawns its own signed relay (random `COLLAB_TOKEN_SECRET`, temp data
dir) and its own `vite preview` of `apps/viewer/dist`, both on ephemeral
ports (the config's shared `:3000` webServer is not started when this is the
only project selected — it would test whichever checkout holds that port), and
enables collab per browser context through the `localStorage`
overrides (`ifc-lite:collab:enabled`, `ifc-lite:collab:server-url`). It
builds a textured AC20 IFCZIP on the fly (`tests/e2e/collab/textured-ac20.ts`,
one wall re-bodied as a textured `IfcTriangulatedFaceSet`), shares it, closes
the owner the instant Copy is enabled, and checks a fresh guest, a rejoin and
the guest's export against the owner's room counts and the textured wall's
byte-exact pixels/UVs. Two controls show the gate at work: slowed blob uploads
(Copy withheld, "Leave (abandons upload)", an abandoned room has no geometry)
and the owner's websocket frames held back (Copy withheld in `confirming`
until the relay's state vector covers the owner's). Numbers and screenshots of
one run: `docs/architecture/evidence/share-seed-ready/`. The spec skips, with a
pointer, when the fixture, the wasm runtime, the viewer build or the relay
build is missing.

### The 3D variant

```sh
pnpm collab:demo:3d
```

Same server on `ws://localhost:1234`, but serves `examples/threejs-collab`
on `http://localhost:5175`: every entity is a real Three.js box on a floor
grid. Drag a wall in tab A and it slides in tab B; peer selections are
outlined in each user's color. Position, size, rotation and color are CRDT
attributes synced over the websocket server.

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
    // Validate JWT, return a { userId, role } principal, or null to reject.
    return null;
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
