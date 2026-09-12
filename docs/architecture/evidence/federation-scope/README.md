# Explicit federation scope — two copies of one file in one room (#4444)

Two runs: the real-browser journey of the issue's reproduction (owner → fresh
guest → rejoin, two Chrome profiles over a signed relay), and the headless
real-fixture run that preceded it. Both use the real Archicad IFC4
`AC20-FZK-Haus.ifc` (SHA-256
`ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d`), loaded
twice so that every IFC identity collides on purpose.

## Browser run (2026-09-12)

`tests/e2e/collab-federation-scope.e2e.spec.ts`, Playwright project
`viewer-collab-e2e`, headless real Chrome (`channel: 'chrome'`,
`--enable-unsafe-webgpu --ignore-gpu-blocklist --enable-gpu`) on Windows 11,
against a disposable `@ifc-lite/collab-server` started by the spec on an
ephemeral loopback port with a random `COLLAB_TOKEN_SECRET` and a temp data
dir, and a private `vite preview` of this checkout's ordinary
`pnpm --filter @ifc-lite/viewer build` on another ephemeral port, pointed at
the relay through the `localStorage` overrides (harness:
`tests/e2e/collab/{relay,preview,viewer-page}.ts`, shared with #4446):

```sh
pnpm fixtures
pnpm turbo build --filter=@ifc-lite/collab-server
pnpm --filter @ifc-lite/viewer build
E2E_EVIDENCE_DIR=<dir> pnpm test:e2e:collab
# 2 passed (44.0s): the two-copy journey 29.8s, the "Active model only" control 9.7s
```

**Owner profile** ([owner-two-copies-painted.png](owner-two-copies-painted.png),
[owner-share-all.png](owner-share-all.png)): Open `AC20-FZK-Haus.ifc`, Add Model
the same file, so the workspace holds two copies (317 meshes each, copy 2 at
federation offset 1 079 108). In the Appearance workspace the same mapped
member — IfcMember `0oTQ6V1VbChulreA_hfmUa` (`Sparren-1`, local #35169 in both
copies), the member of the #4420 evidence — receives an 8×8 solid red PNG in
copy 1 and a solid blue one in copy 2 (scope: current selection, "Convert
supported objects to mesh", box projection, tile X 0.5 m; both applies report
"Appearance applied"), giving the two copies two different texture sources
(`textures/57cda6….png` vs `textures/5c1940….png`). File → Share: the dialog
asks for the scope, **All 2 loaded models** is preselected and kept, **Create
link** creates the room; the link field shows the upload until every slot is
seeded and then the invite; the caption reads "This room carries 2 models.";
**Copy** puts the invite on the clipboard (read back and equal to the field).
The room's document at that point: slots `m0`, `m1`; 184 entities per slot;
313 geometry refs per slot; 626 geometry records; seed marker
`seeded = expected = 634`. The owner profile is then closed.

**Fresh guest profile** — opens the invite with nothing loaded
([guest-copy-a-picked.png](guest-copy-a-picked.png),
[guest-copy-b-picked.png](guest-copy-b-picked.png)):

| Check | Result |
| --- | --- |
| Room models | `room:<roomId>:m0` "AC20-FZK-Haus.ifc" (offset 0) and `room:<roomId>:m1` "AC20-FZK-Haus.ifc (2)" (offset 1 000 185); `collabRoomModels.size` = `models.size` = 2 = seeded slots; both listed in the hierarchy's Models section |
| Geometry | 313 meshes per model = the owner's refs per slot; the guest's copy of the doc has 184 + 184 entities, 626 records |
| Textures | the member's mesh in `m0` decodes to `[255, 0, 0]` at its own UV, in `m1` to `[0, 0, 255]`; two different texture blob hashes (`e599dd…`, `96db23…`) |
| Store keys | `/m0/0oTQ6V1VbChulreA_hfmUa` in copy 1, `/m1/0oTQ6V1VbChulreA_hfmUa` in copy 2 |
| Picking | with the other copy hidden, the member framed and the roof slab that hides it (Elements → Hide selection, one occluder per copy) out of the way, a real canvas click at the member's projected triangle centre selects global id 47 → `{ modelId: room:…:m0, expressId: 47 }` in copy 1 and 1 000 232 → `{ modelId: room:…:m1, expressId: 47 }` in copy 2 (13 clicks each) |
| Geometry notice | `collabGeometryNotice` null; no "shared model … geometry" toast |
| Export | Export dialog, Model "AC20-FZK-Haus.ifc (IFC5)" then "AC20-FZK-Haus.ifc (2) (IFC5)", schema IFC5 (current), output `.ifcx`, **Export**: two downloads, `AC20-FZK-Haus_export.ifcx` and `AC20-FZK-Haus -2_export.ifcx` (the "(2)" copy suffix survives the extension strip, `sanitizeFilename` then rewrites the parentheses — the first run of this spec downloaded both copies under one name), 111 nodes / 108 entity paths each; the member at `/0oTQ6V1VbChulreA_hfmUa` with its `ifclite::appearance::v1` fragment in both; no node path or child reference under `/m0/` or `/m1/` ([sample](guest-export-m0-sample.json)) |

**Rejoin** — a third profile opens the same invite
([rejoin-copy-b-picked.png](rejoin-copy-b-picked.png)): the same two models,
textures, store keys and picks.

**Control: "Active model only"** ([browser-run-active-only.json](browser-run-active-only.json)):
the same two loaded copies shared with the other scope produce one slot (`m0`),
one guest model "AC20-FZK-Haus.ifc" at offset 0 with 313 meshes, and the
member's global id equals its local express id (47) — the single-model
fallback `globalId === expressId` holds.

The full record of both runs is [browser-run.json](browser-run.json) and
[browser-run-active-only.json](browser-run-active-only.json) (invite tokens
redacted; the relay they were minted for no longer exists).

### Defect found and fixed by this run

The first browser run lost the second copy's geometry: the guest got `m1` with
0 meshes and no notice, while the owner's own doc held 626 records. The relay's
`/metrics` showed `collab_rejects_total{reason="rate-limit"} 21` out of 245
update frames. `seedGeometryToRoom` resolved every mesh's entity path through
a callback that stamps that entity's placement baseline into the doc, each
stamp its own Yjs transaction — one websocket frame per entity, ~245 for two
copies in one burst against the relay's default per-connection budget of 200
(+60/s). The relay dropped the tail, and because Yjs integrates a client's
structs in clock order, every later frame from the owner (the rest of the
stamps, `m1`'s geometry records and refs, the seed marker) stayed pending on
the server. One model (~120 stamps) never reached the budget, which is why no
single-model run saw it. The resolve is now one transaction per slot
(`geometry-sync.ts`); a two-copy seed is 9 frames (4 per slot + the marker),
pinned by `owner-seed.frames.test.ts` (synthetic 260-element copies, 527
frames before the fix) and by the AC20 test below.

## Headless run (2026-09-12)

`apps/viewer/src/lib/collab/room-two-copies.ac20.test.ts`:

```sh
pnpm fixtures
cd apps/viewer && node node_modules/tsx/dist/cli.mjs --import ./src/test/vite-module-hooks.mjs \
  --test src/lib/collab/room-two-copies.ac20.test.ts
```

The fixture is parsed
twice by the real STEP parser (`ColumnarParser.parseLite`) and tessellated by
the real WASM geometry pipeline (`GeometryProcessor.process`), so both copies
share every GlobalId, every express id, the file name and the bytes. Copy B is
re-homed to federation offset 1 000 000 exactly as the loader does for an added
file; the first `IfcWallStandardCase` with a mesh gets a red 2×2 texture in copy
A and a blue one in copy B (the "different appearance source per copy" of the
issue's reproduction).

The run drives the real owner seed (`runOwnerSeed`), a real collab document, a
real `MemoryBlobStore`, the real recipient reconstruct
(`createRoomReconstructor`) with the real IFCX ingest, and the real model/data
store slices. Numbers reported by the test's diagnostic line:

| Quantity | Value |
| --- | --- |
| Entities seeded per slot | 184 |
| Entities in the room (`entities` map) | 368 (= 2 × 184; nothing merged) |
| Meshes offered per copy | 317 |
| Geometry refs per slot | 313 (one entity carries byte-identical items; `addGeometryRef` keeps one ref per hash per entity, as in a single-model room) |
| Content-addressed geometry records | 626 (STEP blobs encode the global express id, so the two copies never dedupe onto each other) |
| Blobs uploaded (seed marker `seeded` = `expected`) | 634 |
| Doc update frames for the whole two-copy seed | 9 |

Assertions that passed, for the fresh guest and again after leave → rejoin:

- the guest holds exactly `room:ac20:m0` and `room:ac20:m1`, named
  `AC20-FZK-Haus.ifc` and `AC20-FZK-Haus.ifc (2)` (the slot records keep the
  owner's name verbatim), in disjoint global-id ranges;
- each model hydrated all 313 of its slot's refs, and the painted wall carries
  red pixels in copy A and blue in copy B;
- the painted wall's global id resolves (`resolveGlobalIdFromModels`) to its
  own model and local express id in each copy — a pick lands on the right copy;
- both models carry their own `ifcDataStore` and `schemaVersion`, which is what
  the Export dialog enumerates; the Export dialog's IFC5 branch
  (`new Ifc5Exporter(store, geometryResult, undefined, idOffset).export({...,
  stripPathPrefix: roomExportPathPrefix(state, modelId) })`) runs on each room
  model and emits 90 meshes per copy (the exporter's spatial-tree filter keeps
  contained elements only; the count is the same for both copies). The
  recipient's store keys the wall by `/m0/<GlobalId>` / `/m1/<GlobalId>`; the
  exported file carries it at `/<GlobalId>` in both copies, every exported
  entity path is a GlobalId of the source model, no path or child reference
  carries a slot, the two files' entity nodes are identical and they differ
  only in the texture carriers (red vs blue pixels), with the wall's texture
  written as an `ifclite::appearance::v1` fragment in both;
- leaving drops both room models; rejoining rebuilds both.

## What the headless run does not claim

The headless run is a Node run: `runOwnerSeed` → `MemoryBlobStore` →
`createRoomReconstructor`, no websocket, no relay budget — which is exactly why
it could not see the frame-budget defect the browser run found. Merged
(federated) export is STEP-only in the dialog, so a recipient exports each room
model to its own `.ifcx`. Path-valued attributes of a custom IFCX schema are not
re-homed under a slot by either run (documented limit, see
`docs/contributing/collaboration-testing.md`).
