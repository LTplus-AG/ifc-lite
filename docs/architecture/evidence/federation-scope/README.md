# Explicit federation scope — two copies of one file in one room (#4444)

Headless acceptance of the multi-model room, run on 2026-09-12 with
`apps/viewer/src/lib/collab/room-two-copies.ac20.test.ts`:

```sh
pnpm fixtures
cd apps/viewer && node node_modules/tsx/dist/cli.mjs --import ./src/test/vite-module-hooks.mjs \
  --test src/lib/collab/room-two-copies.ac20.test.ts
```

The real Archicad IFC4 `AC20-FZK-Haus.ifc` (SHA-256
`ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d`) is parsed
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
  (`new Ifc5Exporter(store, geometryResult, undefined, idOffset).export(...)`
  with the dialog's options) runs on each room model and emits 90 meshes per
  copy (the exporter's spatial-tree filter keeps contained elements only; the
  count is the same for both copies), the painted wall at `/m0/<GlobalId>` in
  copy A and `/m1/<GlobalId>` in copy B — the recipient's store keys entities
  by their slot-qualified room path — with its texture written as an
  `ifclite::appearance::v1` fragment in both;
- leaving drops both room models; rejoining rebuilds both.

## What this evidence does not claim

This is a Node run, not a browser one. The two-profile browser flow of
`docs/contributing/collaboration-testing.md` ("Sharing several models") —
File → Share with two loaded copies, **Create link**, a fresh guest profile
opening the link, rejoin, and the Export dialog on the guest — was not run for
this change. The rendered picking and the room IFCX export through the dialog
are therefore covered by the store-level and exporter-level assertions above,
not by screenshots. Merged (federated) export is STEP-only in the dialog, so a
recipient exports each room model to its own `.ifcx`.
