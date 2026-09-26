# @ifc-lite/collab

## 0.9.2

### Patch Changes

- [#5992](https://github.com/LTplus-AG/ifc-lite/pull/5992) [`8901816`](https://github.com/LTplus-AG/ifc-lite/commit/8901816fa9171b1af0a9af5036105db0fa72cb24) Thanks [@louistrue](https://github.com/louistrue)! - An `IfcAxis2Placement3D` with an absent (`$`) `RefDirection` now gets the same local X axis everywhere in TypeScript as the renderer draws ([#5922](https://github.com/LTplus-AG/ifc-lite/issues/5922)). The new `firstProjAxis(axis)` export in `@ifc-lite/data` is the one TypeScript copy of that fill. It mirrors `build_axis2_matrix` in the Rust geometry crate: world X projected onto the plane normal to the Axis, and `(0,0,1) x Axis` when that projection is shorter than 1e-6. So an Axis of exactly -X gets `(0,-1,0)`.
  
  Model compare used world Y there. That turned the compared frame 180 degrees about the Axis relative to the viewer. The LOD0 exporter, the viewer's storey display elevation, and collab `placementToMatrix` each had their own fallback, and those gave a frame 90 degrees off for ±X Axes. The viewer's slab split read such a solid Position as identity. All of these now call `firstProjAxis`, as does `@ifc-lite/create` when it completes an Axis-only placement.
- Updated dependencies [[`8901816`](https://github.com/LTplus-AG/ifc-lite/commit/8901816fa9171b1af0a9af5036105db0fa72cb24), [`48e64d4`](https://github.com/LTplus-AG/ifc-lite/commit/48e64d44d418c913860c21e457d9053690ebd66c), [`28ae5b0`](https://github.com/LTplus-AG/ifc-lite/commit/28ae5b0bf1ce37fd592651113f3e765caa980291), [`efc652c`](https://github.com/LTplus-AG/ifc-lite/commit/efc652c475f71b0d884d5c746b3156516618d1e3)]:
  - @ifc-lite/data@6.1.0
  - @ifc-lite/mutations@2.9.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9)]:
  - @ifc-lite/data@6.0.0
  - @ifc-lite/mutations@2.7.1
  - @ifc-lite/ifcx@4.2.1

## 0.9.0

### Minor Changes

- [#5294](https://github.com/LTplus-AG/ifc-lite/pull/5294) [`dec98a2`](https://github.com/LTplus-AG/ifc-lite/commit/dec98a2c97e03e70e8b78c55bb27e87b5b4013a6) Thanks [@louistrue](https://github.com/louistrue)! - Fix `mergeBranch(..., 'layer')` recreating an entity that the parent deleted after the fork. The branch's IFCX snapshot carries every entity the branch still has, including ones it never touched, and the overlay created any of those the parent lacked. `forkSession` now records the parent's Yjs state vector inside the branch doc (`meta` key `branch.forkStateVector`). A layer merge drops a snapshot node whose path the parent no longer has when the branch's copy is the entity it inherited at fork. A branch that deleted and re-created that path after the fork still merges it.
  
  `MergeReport.droppedDeletions` is computed from the same record, so it no longer depends on the branch session still holding the original `Y.Doc` object. Before, a reload, a second tab, or a merge job rebuilding the session reported a confident `0` and also lost the resurrection guard. The type is now `number | null`. `null` means the branch doc has no fork record (it was forked by an earlier version); in that case neither the count nor the parent-deletion guard could be applied. It never means zero.

### Patch Changes

- [#5287](https://github.com/LTplus-AG/ifc-lite/pull/5287) [`074178f`](https://github.com/LTplus-AG/ifc-lite/commit/074178f651c21dacbfbec33534701a59a7e81ace) Thanks [@louistrue](https://github.com/louistrue)! - Fix the conflict detector throwing a `TypeError` out of `Y.applyUpdate` when it is attached to a raw `Y.Doc` (for example one passed as `CollabSessionOptions.doc`) whose top-level maps had never been accessed locally. The first remote update decoded `entities` as a bare `Y.AbstractType`, and because the detector watches the same doc the websocket provider writes to, the throw landed inside the provider's message handling. The detector now initialises the maps it reads when it is created, so that update is classified normally instead of crashing.
  
  Also fix the detector missing conflicts when a single `Y.applyUpdate` carries writes from more than one remote client (relay catch-up, a merged diff, coalesced updates). It used to attribute the whole transaction to one guessed client. It now reads the structs the transaction inserted and credits every client that wrote the key, so a conflict is reported the same way whether it arrives batched or as separate transactions.

- [#5435](https://github.com/LTplus-AG/ifc-lite/pull/5435) [`f942fb6`](https://github.com/LTplus-AG/ifc-lite/commit/f942fb6c48ac9be1464e49fd963340835a72945d) Thanks [@louistrue](https://github.com/louistrue)! - IFCX export no longer silently merges same-named properties from different property sets ([#5376](https://github.com/LTplus-AG/ifc-lite/issues/5376)). Before this change, every pset property went out under `bsi::ifc::prop::<Name>`, which has no pset component. Two psets on one entity that shared a name wrote the same key, the last value won, and on import the pset each property came from could not be recovered.
  
  - With `onlyKnownProperties: false` (full fidelity, used by Export Changes), every pset property is now written under `bsi::ifc::v5a::<Pset>::<Name>` as a typed `{ type, value }` record. This is the pset-qualified form collab snapshots and MCP draft ops already write, so nothing is lost, and re-import restores each pset with its real name.
  - The flat `bsi::ifc::prop::<Name>` key is still written, but only for names the official IFC5 property schema (`prop@v5a.ifcx`) defines, so standard IFCX consumers still find them. Custom names such as `Reference` no longer get a flat key the schema does not define.
  - `Ifc5ExportResult.stats.propertyCollisions` lists every official flat key that two psets on one entity disagreed on. `valueLost` is true when only the flat key was written (`onlyKnownProperties: true`), which means one value is missing from the file. The viewer's IFCX export toast now reports lost values.
  - On import, `@ifc-lite/ifcx` skips a flat key that only mirrors a pset-qualified value on the same node, so the property is not listed twice.
  - `PROPERTY_TYPE_NAMES` (`PropertyValueType` → IFC defined type name for typed records) now lives in `@ifc-lite/ifcx`, shared by the exporter and collab. `@ifc-lite/collab` still re-exports it.
  
  Files written before this change still read the same: their flat keys land in "IFC Properties", as before.

- [#5289](https://github.com/LTplus-AG/ifc-lite/pull/5289) [`685b541`](https://github.com/LTplus-AG/ifc-lite/commit/685b5414f57eec64c74e056b9b51b6b8ffe3a88f) Thanks [@louistrue](https://github.com/louistrue)! - Fix `applyIfcxOverlay` silently dropping a concurrent peer's deletion. Cross-call overlay tombstones were stored as one JSON array under a single doc key. When two peers tombstoned different paths at the same time, each wrote its whole array, Yjs kept only the last write, and one peer's deletion was lost even though both peers converged. A later layer with no opinion on that path could then resurrect it. Tombstones now live one per path in a dedicated root-level map (`overlay.tombstones.registry`), so concurrent deletions of different paths no longer race.
  
  Migration: a doc written before this change is still honoured. Its legacy `meta` array is read and never written again, and an explicit per-path revival overrides a stale legacy entry. Rollout limit: an old-code peer and a new-code peer editing the same room at the same time are not supported. The old peer only reads the legacy array, which stops being updated, so it will not see tombstones the new peer records. Upgrade every client of a room together.
- Updated dependencies [[`35b8b23`](https://github.com/LTplus-AG/ifc-lite/commit/35b8b238821138d6c5bc94d3ad51abf832677a88), [`83284a9`](https://github.com/LTplus-AG/ifc-lite/commit/83284a947d9adb9e1ece28f9d5ee7166722be1e5), [`992f553`](https://github.com/LTplus-AG/ifc-lite/commit/992f55304ca0ec8ed5be3b4eabab429c68808a7e), [`e66c849`](https://github.com/LTplus-AG/ifc-lite/commit/e66c849b6a79de9691a1e70ee3b2b593c5327fa1), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`a250a92`](https://github.com/LTplus-AG/ifc-lite/commit/a250a928b1c8c64ac6153136772fe6c71398eee9), [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`bd15b3f`](https://github.com/LTplus-AG/ifc-lite/commit/bd15b3f607f43ab47c8f4d530ed95231f802e15c), [`eebb00e`](https://github.com/LTplus-AG/ifc-lite/commit/eebb00e52719e0254d1626f791740ce7fe7489a9), [`f942fb6`](https://github.com/LTplus-AG/ifc-lite/commit/f942fb6c48ac9be1464e49fd963340835a72945d), [`58691b3`](https://github.com/LTplus-AG/ifc-lite/commit/58691b362d67ab87f666d76d6ee27e39d1ec45f9), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`71ace41`](https://github.com/LTplus-AG/ifc-lite/commit/71ace41b0ccfde286fe7fc1074011a91c9c8d5b1), [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d)]:
  - @ifc-lite/mutations@2.7.0
  - @ifc-lite/data@5.1.0
  - @ifc-lite/ifcx@4.2.0

## 0.8.1

### Patch Changes

- Updated dependencies [[`d38af5a`](https://github.com/LTplus-AG/ifc-lite/commit/d38af5afd36f12329fe6f33bf905d28fca65ba43), [`0100a54`](https://github.com/LTplus-AG/ifc-lite/commit/0100a544d0446d2f19b5f76f37d6dc45d31da837), [`e1ace4f`](https://github.com/LTplus-AG/ifc-lite/commit/e1ace4f05a45a252d502bf72a506336185d2b157), [`ab8380e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8380e6b9edf1ca1f05abf343ae6040ac8aee77), [`6a5f3f2`](https://github.com/LTplus-AG/ifc-lite/commit/6a5f3f2ae703ce170b890f85535af846251d3ab7), [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`e211790`](https://github.com/LTplus-AG/ifc-lite/commit/e211790ff4d7070d908fb519652158089652dd9c)]:
  - @ifc-lite/data@5.0.0
  - @ifc-lite/mutations@2.5.0
  - @ifc-lite/ifcx@4.1.2

## 0.8.0

### Minor Changes

- [#4546](https://github.com/LTplus-AG/ifc-lite/pull/4546) [`e18a434`](https://github.com/LTplus-AG/ifc-lite/commit/e18a434ec2258e474728bd9a90146486b38efedb) Thanks [@louistrue](https://github.com/louistrue)! - Rooms carry an explicit federation scope: one model slot per shared model ([#4444](https://github.com/LTplus-AG/ifc-lite/issues/4444)).
  
  - `@ifc-lite/collab`: new top-level `models` map and `doc/model-slot` helpers (`modelSlotRef`, `slotPath`, `pathInSlot`, `prefixPathForSlot`, `createModelSlot`, `listModelSlots`, …). `seedFromStep` / `seedFromIfcx` accept a `slot` option that qualifies every entity path with `/<slotId>` (children and inherits references included); `snapshotToIfcx` accepts `slot` to emit one slot's entities with that slot's own IFCX header / imports / schemas (recorded per slot under `meta.ifcxFile:<slotId>`; a whole-room snapshot merges them in slot order). Slot ids are minted in share order, never from a file name, its bytes or its GlobalIds, so two copies of one file are two slots. Rooms seeded before slots existed keep their unqualified `/<GlobalId>` paths and room-wide file metadata, and are read as one implicit legacy slot — no migration, nothing on disk is rewritten. Known limit: an IFCX seed re-homes `children` / `inherits` references under the slot but not path-valued attributes of a custom schema, which keep the file's unqualified path.
  - Viewer: with several models loaded, the Share dialog asks whether to share the active model only or all loaded models (default: all — the workspace on screen is the federation) and creates the room only on **Create link**, since a room's scope is fixed by its seed. Each model is seeded from its own store and meshes into its own slot, one after another; `collabSeedProgress` carries `modelIndex` / `modelCount` and the upload row reads "model 2 of 3". A recipient reconstructs one federated model per slot (`room:<roomId>:<slotId>`), registered through the federation registry in its own global-id range, so two copies of one file — same GlobalIds, same local express ids — are two selectable, editable, exportable models with their own geometry and textures (the second is listed as "<name> (2)" on the recipient). An owner with nothing seedable (a model still loading, a GLB or point-cloud workspace) still creates the room as its owner with an empty scope, and the "All loaded models" option counts what can be shared rather than what is loaded. Inbound peer edits are routed to the model their path's slot names; outbound mirrors gate per model.

- [#4608](https://github.com/LTplus-AG/ifc-lite/pull/4608) [`53003de`](https://github.com/LTplus-AG/ifc-lite/commit/53003de1e36a956b7f51e9dffc035218477d5d3c) Thanks [@louistrue](https://github.com/louistrue)! - Add portable STEP archive metadata to collaboration slots and a bounded IFCZIP resource extractor so shared annotations retain referenced appearance resources safely. Property overlays can now delete one quantity while retaining its quantity set.

- [#4553](https://github.com/LTplus-AG/ifc-lite/pull/4553) [`4ab63cd`](https://github.com/LTplus-AG/ifc-lite/commit/4ab63cd72e374dbdc98b6f59599fb9d2050f0f85) Thanks [@louistrue](https://github.com/louistrue)! - Sharing: the invite is withheld until the relay confirms it holds the model ([#4446](https://github.com/LTplus-AG/ifc-lite/issues/4446)). The owner seed ends in a new `confirming` phase: `@ifc-lite/collab` gains `fetchRoomStateVector` (reads a room's state vector from the sync handshake of a throw-away connection), `stateVectorCovers` and `roomSocketUrl`, and `runOwnerSeed` reports `ready` only once the relay's state vector covers the owner's — a local transaction only proves the bytes are queued in the browser's socket, and a tab closed at that moment used to leave the room empty. Share dialog and Room panel show "Confirming the upload with the room server…" meanwhile; a relay that stays out of reach settles the seed as failed with an owner-facing message, while a relay that answers but is still behind is waited for (probes back off 250 → 500 → 1000 ms). The automated relay acceptance (`tests/e2e/collab-share-seed.e2e.spec.ts`, Playwright project `viewer-collab-e2e`) proves the fresh-guest / rejoin / export journey over a disposable signed relay.

### Patch Changes

- Updated dependencies [[`53003de`](https://github.com/LTplus-AG/ifc-lite/commit/53003de1e36a956b7f51e9dffc035218477d5d3c)]:
  - @ifc-lite/mutations@2.3.0
  - @ifc-lite/ifcx@4.1.1

## 0.7.0

### Minor Changes

- [#4352](https://github.com/LTplus-AG/ifc-lite/pull/4352) [`dbf513b`](https://github.com/LTplus-AG/ifc-lite/commit/dbf513b785f1dbc2f2dce5c173d28fd5ab65aa0c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add `MergeReport.droppedDeletions` so a caller of `mergeBranch(parent, branch, 'layer')` can detect when a branch-side deletion did not propagate to the parent — a documented limitation of the IFCX snapshot wire format, which cannot distinguish "removed" from "no opinion". Pin the deletion-drop behaviour itself with a regression test in `test/branch-merge-layer-overlay.test.ts`.

### Patch Changes

- [#4355](https://github.com/LTplus-AG/ifc-lite/pull/4355) [`7179a9c`](https://github.com/LTplus-AG/ifc-lite/commit/7179a9c6c2d0620f6bd3260e37b80c771697ce85) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `createConflictDetector`'s `classify()` returned `null` for every entity create on the top-level entities map, on the documented reasoning that concurrent creates are CRDT-friendly since both entities coexist — true only when the two peers pick different paths. When two offline peers independently create at the same path (e.g. each assigns the next sequential id from its own local view), Yjs LWW keeps exactly one peer's entity and silently discards the other's class/attributes/psets, and no `ConflictEvent` ever fired for it. `classify()` now surfaces this as a new `concurrent-create` `ConflictKind`; a create at a non-colliding path still raises nothing, since the detector only flags once two distinct clients write the same `(kind, path)` key within the window. Merge semantics (LWW) are unchanged — this is detection only. `test/conflict-scenarios.test.ts` and `test/convergence-property.test.ts` gain regression coverage for the same-path collision, the different-path false-positive guard, and a survival assertion so a lost write is visible to the randomized convergence test instead of only checked for agreement. Delete-vs-edit remains an undetected, documented gap — it does not fall out of this change since a top-level delete and a nested attribute edit classify under different `ConflictKind`s and never share a detector key.
- Updated dependencies [[`ced8bb4`](https://github.com/LTplus-AG/ifc-lite/commit/ced8bb46c368648bd54a1bab716d049143faa036), [`e119819`](https://github.com/LTplus-AG/ifc-lite/commit/e1198197556375019c5a7820cc7c99da55e5c639), [`b0700f2`](https://github.com/LTplus-AG/ifc-lite/commit/b0700f25434d1cf1ec5f7438a8e27c09188208ec), [`8620be3`](https://github.com/LTplus-AG/ifc-lite/commit/8620be38be0162b7cbdbe23ae7bc924763b83612), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`5a01e5a`](https://github.com/LTplus-AG/ifc-lite/commit/5a01e5abe220f21ae5233045c6e9cfc5aa37a4e3), [`b9c3aa1`](https://github.com/LTplus-AG/ifc-lite/commit/b9c3aa1b7da9b0c26742bacb6eb3c7c4b44ca80b), [`591c593`](https://github.com/LTplus-AG/ifc-lite/commit/591c5938bdc4e8210c3b3158f22ecd78552bcdc2)]:
  - @ifc-lite/data@4.1.0
  - @ifc-lite/mutations@2.2.0
  - @ifc-lite/ifcx@4.1.0

## 0.6.1

### Patch Changes

- [#3604](https://github.com/LTplus-AG/ifc-lite/pull/3604) [`53a92b1`](https://github.com/LTplus-AG/ifc-lite/commit/53a92b1f7cc5770f164dc4867fc2adc33470e245) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `createGeometry` no longer drops an explicit empty-string `blobHash` (`if (opts.blobHash)` was a truthiness check, so `blobHash: ''` never made it into the Y.Doc — the value was lost before there was anything to snapshot or seed back). `createGeometry` now checks `!== undefined`, matching the contract `upsertGeometry` already used.

- [#3469](https://github.com/LTplus-AG/ifc-lite/pull/3469) [`c78ce8c`](https://github.com/LTplus-AG/ifc-lite/commit/c78ce8c3f1da3b8b2c6fa0f982595adc8c48b7d6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `MemoryBlobStore.put()` keeping the FIRST upload's `uploadedAt` forever on a re-put of already-known content, instead of refreshing it like `IndexedDbBlobStore` and `HttpBlobStore` already do.
  
  `put()` deduplicates by content hash and returned a fresh `meta` object either way, but only wrote it to the store on the first call for a given hash — a later `put()` of the same bytes handed the caller a meta claiming the current time while `stat()`/`get()` kept reporting the original upload time. Blob GC's grace-window check (`planBlobSweep` in `packages/collab/src/geometry/gc.ts`) reads that stored `uploadedAt` to decide whether an unreferenced-right-now blob is too young to sweep; a client re-references (and re-PUTs) a blob specifically to refresh that clock, per the race-protection this store's own sibling implementations already rely on. With the stale timestamp, a blob re-uploaded long after its original upload read back as old enough to sweep immediately.
  
  `put()` now always writes the fresh `meta` (reusing the already-stored bytes rather than copying them again), matching `IndexedDbBlobStore` and `HttpBlobStore`.

- [#3569](https://github.com/LTplus-AG/ifc-lite/pull/3569) [`4735f1c`](https://github.com/LTplus-AG/ifc-lite/commit/4735f1cbb6635016e83c7890f670e615bbdc48c3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `applyIfcxOverlay` silently resurrecting an entity a previous, separately-arriving layer had deleted.
  
  `applyIfcxOverlay` writes a file's opinions onto a doc that may already hold the paths involved — used by `mergeBranch(parent, branch, 'layer')` and by any other caller applying a sequence of layers/ops to the same doc. Within one call, a delete-then-resurrect sequence already resolved correctly ("the last opinion wins"), but `deleteEntity` purges the path from `entitiesMap` entirely, so once that call's transaction ended there was nothing left on the doc distinguishing "deleted, no opinion since" from "never existed". A later, separate `applyIfcxOverlay` call touching the same path with no opinion on deletion at all read `hasEntity() === false` as "brand new" and silently recreated the entity via `createNodeEntity`, losing the deletion and every attribute the deleted entity had carried that the new layer did not itself restate. Two layers applied in different orders — a delete-op and an unrelated set-op on the same path — converged to two different final states depending only on which was applied first: order A (delete, then set) left the entity alive; order B (set, then delete) left it deleted.
  
  `applyIfcxOverlay` now records paths it deletes in a small persistent set on the doc's meta map, and a later call that touches such a path without itself stating a deletion opinion leaves it deleted rather than recreating it. An explicit revive (`ifclite::deleted: false`) still resurrects the entity as before, and the tombstone is cleared once it does.

- [#3855](https://github.com/LTplus-AG/ifc-lite/pull/3855) [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e) Thanks [@louistrue](https://github.com/louistrue)! - Corrected the code samples on each package's npm landing page: the README fences are now typechecked against the package's real exports, so the snippets import what they call, declare the values they read, and no longer show removed options or renamed methods. Patch-bumping every package whose README changed so the corrections actually reach npmjs.com.
- Updated dependencies [[`bcbe7b9`](https://github.com/LTplus-AG/ifc-lite/commit/bcbe7b9afa38e8dafb5900e73575c71a8fd96012), [`793fce2`](https://github.com/LTplus-AG/ifc-lite/commit/793fce217039f11d6b74f898daed03f48c33809d), [`586fa29`](https://github.com/LTplus-AG/ifc-lite/commit/586fa292b69cdb3ba6e45764b4ff742b2fa7b9a9), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`cebcb21`](https://github.com/LTplus-AG/ifc-lite/commit/cebcb2133ef672e9199ee2f158578499d449d9e0), [`e986c81`](https://github.com/LTplus-AG/ifc-lite/commit/e986c81bf6d28fec57f1953fa53bf315dbd80a3a), [`8c181c9`](https://github.com/LTplus-AG/ifc-lite/commit/8c181c99f91964402ad352aead36d9619af5b427), [`6e48c4c`](https://github.com/LTplus-AG/ifc-lite/commit/6e48c4c5f441e8a42e4cc55440cf747ad8679f0a), [`8f08715`](https://github.com/LTplus-AG/ifc-lite/commit/8f087158a662a02c01a21dd2546fb863bb24e665), [`9b709c5`](https://github.com/LTplus-AG/ifc-lite/commit/9b709c51480fbabb68167aa4892f7e4c87b0e4e6), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`89c4cf2`](https://github.com/LTplus-AG/ifc-lite/commit/89c4cf22e83d76115035f7dcbf6e34f9c06dd091), [`19f1312`](https://github.com/LTplus-AG/ifc-lite/commit/19f13120a05cd3a3b729eeaf5550cff71b7506d9), [`82c77c1`](https://github.com/LTplus-AG/ifc-lite/commit/82c77c118d5a4be8e5ee5b7f7e0648514e9fb74e), [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e), [`a1aebc8`](https://github.com/LTplus-AG/ifc-lite/commit/a1aebc822b819221258f4759edf4c82ff0d140f7), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`a1069f8`](https://github.com/LTplus-AG/ifc-lite/commit/a1069f8f096fcfc5771200a2748466096c3463d5), [`dc8198c`](https://github.com/LTplus-AG/ifc-lite/commit/dc8198ce3f9b9be4b2420dce90343822e0079465), [`1060a30`](https://github.com/LTplus-AG/ifc-lite/commit/1060a30187c8f6bb327f9e356056f2364568e8ff), [`a2488e8`](https://github.com/LTplus-AG/ifc-lite/commit/a2488e858bc7792cdcc818f7759c0a6e46e7d892), [`8368339`](https://github.com/LTplus-AG/ifc-lite/commit/83683393654d8c1b903f03b5c6e9e5ff111fdaf0)]:
  - @ifc-lite/data@4.0.0
  - @ifc-lite/mutations@2.0.0
  - @ifc-lite/ifcx@4.0.0

## 0.6.0

### Minor Changes

- [#3090](https://github.com/LTplus-AG/ifc-lite/pull/3090) [`228bbe7`](https://github.com/LTplus-AG/ifc-lite/commit/228bbe730522148ea797780c5acd08502b18a3a3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `mergeBranch(parent, branch, 'layer')` silently dropping every edit the branch made to an entity that already existed in the parent.
  
  The `'layer'` strategy snapshotted the branch as IFCX and fed the result to
  `seedFromIfcx`. That seeder routes every node through `createEntity`, which
  is a deliberate no-op on a path the doc already holds — right for seeding a
  doc from a snapshot, wrong for merging. Since a branch forks from its
  parent, essentially every entity the branch *modified* was already present
  in the merge target, so the merge landed only the branch's brand-new
  entities and discarded all of the modifications: attributes, children,
  inherits, psets, quantities, classifications, materials and geometry refs
  alike.
  
  A new `applyIfcxOverlay(doc, file)` applies an IFCX file as a layer of
  opinions rather than as a seed, and `mergeBranch('layer')` now uses it. It
  creates entities the doc lacks exactly as the seeder does; for entities
  already present it writes the file's opinions on top — values overwrite,
  `null` removes a flat attribute, child or inherit, an `ifclite::deleted:
  true` node deletes — and leaves untouched anything the file says nothing
  about.
  
  Read that last clause narrowly. `mergeBranch('layer')` sends a FULL snapshot,
  so the file has an opinion on nearly everything: a value the parent changed
  after the fork is overwritten by the branch's fork-time value even when the
  branch never edited it. This is the trade the release makes: previously a
  layer merge dropped the branch's edits, now it applies them, and the price is
  that the branch's fork-time value can win over a newer parent one. Attributes
  and geometry behave the same way here; geometry is not a special case.
  
  One consequence is specific to geometry. Blob GC derives the set it RETAINS
  from the live doc and sweeps the complement, so reverting a `blobHash` flips
  which blob counts as an orphan; a sweep between the parent's re-mesh and the
  merge can leave the restored reference pointing at a blob that has been
  deleted.
  
  Geometry records go through `upsertGeometry` rather than `createGeometry`,
  which returns an existing record untouched. Without that, a branch that
  re-meshed geometry the parent already had merged "successfully" and left the
  parent on the old blob hash.
  
  `seedFromIfcx` is unchanged in both its behaviour and its options: it stays
  additive and idempotent, because `apps/viewer` and `snapshot/worker.ts` use
  it to seed live session docs, where overlaying a snapshot onto live edits
  would be the worse bug on the more common path.
  
  One limit is worth stating plainly, since it is a property of the wire
  format and not of this fix: a full IFCX snapshot emits only what an entity
  *has*, so an entity or attribute the branch deleted is simply absent rather
  than nulled or tombstoned. `mergeBranch('layer')` therefore still does not
  propagate deletions made on the branch. `applyIfcxOverlay` does honour
  deletions when a layer states them explicitly.
  
  A second limit, this one in the code: a nulled pset or quantity property is
  NOT removed. `extractMinimalLayer` flattens those into
  `bsi::ifc::v5a::<Set>::<Prop>` attribute keys, so the removal arrives as an
  attribute null and is looked for in the flat attribute map, where it never
  was. The property survives and the call returns normally. Only flat
  attributes, children and inherits are removed today.

- [#3092](https://github.com/LTplus-AG/ifc-lite/pull/3092) [`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop a collab snapshot round trip from inventing per-entity provenance, and carry the real thing on the wire.
  
  `snapshotToIfcx` wrote nothing about who created an entity or when, because
  IFCX nodes had no provenance slot. `seedFromIfcx` then filled both fields in
  from the file header — which names whoever serialized the *file*, not
  whoever authored each entity, and for a snapshot of a collab doc that is the
  snapshotter plus the write clock. An entity carrying `createdBy: 'ada'` /
  `createdAt: '2019-05-05'` came back claiming a different author and a
  different date, in a shape indistinguishable from genuine attribution. A
  missing field reads as "unknown"; a fabricated one gets trusted.
  
  Two changes:
  
  - **A wire carrier.** `ifclite::meta` (new member of `IFCLITE_ATTR`, the
    extension namespace that already carries collab's classifications,
    materials and geometry refs) holds `createdBy`, `createdAt`,
    `lastEditedBy`, `lastEditedAt` and `previousPath`, so real provenance
    survives snapshot → seed. Values are shape-gated on the way in: only
    strings are read, and a foreign value under the key stays an ordinary
    flat attribute. Every field carried is written once at entity creation
    and never re-stamped — a per-edit stamp would put this attribute in
    every minimal layer and give the merge engine a component that conflicts
    on every concurrent edit.
  - **No more header defaults.** `seedFromIfcx` and `seedFromStep` no longer
    copy `header.author` / `header.timestamp` onto every entity, and no longer
    stamp the read clock as `createdAt`. What the wire does not say now stays
    unset. The file-level record is still available as `meta.header` /
    `meta.stepHeader`.
  
  `createEntity` also now writes the `bsi::ifc::class` attribute when given an
  `ifcClass`. `meta.ifcClass` is doc-local bookkeeping with no wire form, so
  an entity whose class was only ever passed as that option snapshotted
  without a class and came back classless; the MCP draft path had already
  open-coded the attribute at its own call site to work around this.
  
  Scope: `lastEditedBy` / `lastEditedAt` survive only because nothing
  re-stamps them today. Relationships (the doc's separate `relationships`
  map) still do not survive a snapshot — IFCX has no relationship node and
  no first-party writer populates that map; `snapshot-relationships.test.ts`
  pins that as a tripwire rather than papering over it.

### Patch Changes

- [#3022](https://github.com/LTplus-AG/ifc-lite/pull/3022) [`66697fc`](https://github.com/LTplus-AG/ifc-lite/commit/66697fc57de1de4475a2c5eed4361e0e378e0f7a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `sweepBlobs` reporting a blob as reclaimed even when the underlying `store.delete()` call failed.
  
  `sweepBlobs` computed how many deletes actually succeeded but then discarded that count and returned `decision.reclaimBytes` unconditionally — the full byte total `planBlobSweep` had planned to free, regardless of whether any individual `delete()` call reported failure (a remote backend 404, a race with another sweep, a transient error). A caller using the return value for storage-capacity accounting would believe more space was freed than actually was, while the undeleted blob kept consuming storage. `planBlobSweep` now records each dropped hash's byte length on the `SweepDecision`, and `sweepBlobs` sums only the bytes for hashes whose `delete()` actually returned `true`.

- [#3004](https://github.com/LTplus-AG/ifc-lite/pull/3004) [`2580830`](https://github.com/LTplus-AG/ifc-lite/commit/25808308bbbc63eb0fd8b25e6dd0c08864adb6a8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `snapshotToIfcx` writing a literal `null` for a flat attribute value that its own counterpart, `seedFromIfcx`, treats as an IFCX removal opinion and silently drops.
  
  A doc attribute can legitimately hold `null` (e.g. a user clearing a root
  attribute like `Description` through the viewer's mutation bridge). Before
  this fix, `snapshotToIfcx` serialized that value verbatim, so a
  snapshot -> seed -> snapshot cycle was not idempotent: the first snapshot
  carried `"Description": null`, the intervening seed dropped the key per
  `from-ifcx.ts`'s documented contract, and the second snapshot of the
  re-seeded doc omitted the key entirely - two snapshots of "the same" doc
  state disagreeing with each other.
  
  `snapshotToIfcx` now drops null-valued attributes on the way out, matching
  the reader's contract instead of handing it a value it is guaranteed to
  discard on the next round-trip.
- Updated dependencies [[`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0), [`9359bc4`](https://github.com/LTplus-AG/ifc-lite/commit/9359bc488173585b2b90e124cc66dcf8292c4be9), [`f6febcc`](https://github.com/LTplus-AG/ifc-lite/commit/f6febcc2d4986e79b3c44d63853bb72a16475c65), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`412f78c`](https://github.com/LTplus-AG/ifc-lite/commit/412f78c1bf4907f8c230fc149bbb00e0711b6689), [`487866d`](https://github.com/LTplus-AG/ifc-lite/commit/487866dac131bf50a0b3008ddce5db933768dca2), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`116a3e9`](https://github.com/LTplus-AG/ifc-lite/commit/116a3e94de753b95fa94b2d6c41a0171cd254729)]:
  - @ifc-lite/ifcx@3.0.0
  - @ifc-lite/data@3.4.1
  - @ifc-lite/mutations@1.27.0

## 0.5.0

### Minor Changes

- [#2801](https://github.com/LTplus-AG/ifc-lite/pull/2801) [`b14e710`](https://github.com/LTplus-AG/ifc-lite/commit/b14e710ae8d56f518f84abb4d4ec8d1f98aacad8) Thanks [@louistrue](https://github.com/louistrue)! - `BlobStore.put` now accepts an optional `AbortSignal`, and `HttpBlobStore`
  forwards it to `fetch`.
  
  A hung upload was worse than a failed one: a rejection is counted, retried and
  can trip a caller's failure ceiling, but a request that never settles produces
  no failure at all, so nothing retries, no ceiling trips, and a geometry seed
  never resolves while the UI reports work in progress. `LayeredBlobStore` also
  forwards the signal, since its `Promise.all` cannot settle while the remote half
  hangs and its `.catch` never runs when nothing rejects.
  
  Additive and optional: existing callers are unaffected, and implementations that
  cannot abort may ignore the option.

### Patch Changes

- [#2706](https://github.com/LTplus-AG/ifc-lite/pull/2706) [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Dispose the presence object (and its two live timers — the awareness eviction sweep and y-protocols' own outdated-clients timer) when `createCollabSession` fails after `createPresence` has already run, instead of leaking it. `presence` is constructed before either persistence provider comes up; if the IndexedDB or WebSocket provider then throws (for example `createIndexedDbProvider` rejecting outside a browser, where `indexedDB` is undefined), the function rejected without a `session` object for the caller to call `.dispose()` on, so nothing ever cleared those timers. In a browser this went unnoticed because navigating away reclaims everything; in a Node test process it kept the event loop alive indefinitely — `startCollab`'s entry-race regression test, run together with its sibling collab test files in one process, would pass every assertion and then never let the process exit.
- Updated dependencies [[`05592f8`](https://github.com/LTplus-AG/ifc-lite/commit/05592f8c1ef5b34a00c2ea077542dc68107a7ae5), [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2)]:
  - @ifc-lite/mutations@1.26.1
  - @ifc-lite/data@3.4.0
  - @ifc-lite/ifcx@2.3.7

## 0.4.2

### Patch Changes

- [#2336](https://github.com/LTplus-AG/ifc-lite/pull/2336) [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `promoteEntityType` silently discarding data when its target path already exists. `createEntity` is documented as idempotent — a pre-existing path is a no-op that returns the existing entity unchanged — but `promoteEntityType` deletes the source path unconditionally before calling it. If the target already existed (e.g. seeded by a concurrent peer, or a prior promotion that landed on the same path), the call reported success with a truthy `Y.Map` while the source entity's carried attributes, children and meta were permanently lost and the target kept its stale data. `promoteEntityType` now throws before deleting the source when the target path is already occupied, matching this file's existing convention of throwing on precondition violations (`setAttribute`, `setChild`, etc.) instead of silently discarding data.

- [#2337](https://github.com/LTplus-AG/ifc-lite/pull/2337) [`29409e5`](https://github.com/LTplus-AG/ifc-lite/commit/29409e57227d3c458707dbc2cf0cb2e8ae8fcf7b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two gaps found while auditing files with no direct test coverage:

  - `createConflictDetector` classified concurrent writes to a Pset property as a `pset-property` conflict but had no matching case for the structurally identical Qset (quantity) shape — concurrent quantity writes from two peers landed silently with no conflict event, a false negative. `classify()` now handles `ENTITY_KEY.QUANTITIES` the same way it handles `ENTITY_KEY.PSETS`, emitting a new `quantity` `ConflictKind`.
  - `redactAuthorMeta` (the "anonymise this project" GDPR helper) blanked `createdBy`/`lastEditedBy` on every entity but never touched the `annotations` map, so a markup pin's `authorId`/`authorName` (real display name) survived redaction untouched. It now blanks both fields on every annotation alongside the existing entity-meta redaction; annotation `note` text and position are left as-is.

- [#2220](https://github.com/LTplus-AG/ifc-lite/pull/2220) [`512406f`](https://github.com/LTplus-AG/ifc-lite/commit/512406f0d21c7e33b8c84a83865ffaff299e7cc1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a snapshot -> seed round trip silently dropping an explicitly-cleared `classifications` or `materials` attribute.

  `inflateStructuredAttributes` (`packages/collab/src/snapshot/structured-attrs.ts`) shape-gated these attributes with `Array.isArray(value) && value.every(isClassificationRefShaped)` (same for materials). `[].every(...)` is vacuously true, so an entity whose classifications/materials were explicitly cleared to `[]` passed the gate, got pulled out of the flat attributes into the structured branch, and `flattenStructuredBranches` only re-emits that branch when it's non-empty — so the key never came back on the next snapshot. A reader who took a snapshot after the clearing landed would see the attribute vanish entirely rather than resolve to `[]`, and could keep serving a stale non-empty value from before the clear. Both branches now require a non-empty array before taking the structured path (mirroring the existing `geometryRefs` guard), so an explicit `[]` stays in the flat attributes and survives the round trip.

- Updated dependencies [[`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`710fd83`](https://github.com/LTplus-AG/ifc-lite/commit/710fd83638b51b2e4744a1ac364827a27dc0fc73), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`8751ba4`](https://github.com/LTplus-AG/ifc-lite/commit/8751ba41dc4d1893530b0f1db6ad0f8fa0d5d3fd), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`35e37ac`](https://github.com/LTplus-AG/ifc-lite/commit/35e37ac99ab444773bfec669cfc5cf3937443942)]:
  - @ifc-lite/data@3.2.2
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/mutations@1.24.2

## 0.4.1

### Patch Changes

- Updated dependencies [[`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f)]:
  - @ifc-lite/data@3.0.0
  - @ifc-lite/mutations@1.21.1
  - @ifc-lite/ifcx@2.3.2

## 0.4.0

### Minor Changes

- [#1730](https://github.com/LTplus-AG/ifc-lite/pull/1730) [`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab) Thanks [@louistrue](https://github.com/louistrue)! - `CollabSession.captureDocState()`: full-state fork point (`Y.encodeStateAsUpdate`) for whole-doc layer publishing via `publishLayer`, distinct from `captureBaseline()`'s state vector for the per-user `extractUserLayer` path. Backs the viewer's live-session draft publishing ([#1717](https://github.com/LTplus-AG/ifc-lite/issues/1717)).

### Patch Changes

- Updated dependencies [[`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483)]:
  - @ifc-lite/mutations@1.20.0

## 0.3.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline ([#1031](https://github.com/LTplus-AG/ifc-lite/issues/1031)): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers. The typed `TypedPropertyValue` record is the canonical wire shape: the MCP `set_property` draft op emits it, property extraction decodes it (and skips `ifclite::` carriers), composition resolves `null` attribute opinions as removals, and `bakeLayers` preserves the persistent carriers while stripping bookkeeping.

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/mutations@1.19.0

## 0.2.7

### Patch Changes

- [#1692](https://github.com/LTplus-AG/ifc-lite/pull/1692) [`4ef69e9`](https://github.com/LTplus-AG/ifc-lite/commit/4ef69e903def842a9d94cd656a5caa176dd344bb) Thanks [@louistrue](https://github.com/louistrue)! - Link-based multiuser collaboration plumbing (ports draft [#937](https://github.com/LTplus-AG/ifc-lite/issues/937)):

  - `@ifc-lite/collab`: STEP → IFCX room seeding (`seedFromStep`), entity placement
    helpers (`usd::xformop` read/write + baselines), shared annotation pins,
    multi-mesh geometry refs (`geomIds` with legacy `geomId` read fallback,
    `addGeometryRef`, `iterGeometries`), presence `role` field, and a browser fix
    for `HttpBlobStore` (bind global `fetch` to avoid "Illegal invocation").
  - `@ifc-lite/collab-server`: signed room tokens (HS256 mint / verify / revoke /
    kick endpoints + `createRoomTokenAuthenticator`), CORS for the HTTP routes,
    disk-backed `FsBlobStorage`, `Room.kickClient` / `RoomManager.peek`, and a CLI
    that wires token auth + disk blobs from `COLLAB_TOKEN_SECRET` /
    `COLLAB_DATA_DIR` (plus a reference Dockerfile + railway.toml).
  - `@ifc-lite/renderer`: `rotateMeshesForEntity/-Entities` — in-place yaw rotation
    of an entity's flat meshes about a pivot (local-frame-origin aware), used by
    live collab placement sync and the viewer's rotate action.

- Updated dependencies [[`ec53138`](https://github.com/LTplus-AG/ifc-lite/commit/ec53138f252578253b55e1caf28a23dc9cc61de9)]:
  - @ifc-lite/ifcx@2.2.3

## 0.2.6

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/data@2.5.2
  - @ifc-lite/ifcx@2.2.2
  - @ifc-lite/mutations@1.18.1

## 0.2.5

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/data@2.5.1
  - @ifc-lite/ifcx@2.2.1

## 0.2.4

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe)]:
  - @ifc-lite/data@2.0.3

## 0.2.3

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/data@2.0.2
  - @ifc-lite/ifcx@2.1.4
  - @ifc-lite/mutations@1.15.3

## 0.2.2

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/data@2.0.1
  - @ifc-lite/ifcx@2.1.3

## 0.2.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/data@2.0.0
  - @ifc-lite/ifcx@2.1.2
  - @ifc-lite/mutations@1.15.1

## 0.2.0

### Minor Changes

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Final integration batch. Closes the last cross-cutting items in the
  plan: the spec §16.3 mutations bridge, open problem #7 (per-section
  locks), the viewer-mount one-liner, the TLS bundle helper, and a
  runnable performance benchmark suite. **+11 tests, total 175 passing.**

  `@ifc-lite/collab`

  - **`bindMutationsToCollab(view, session, opts)`** (spec §16.3): wraps
    `@ifc-lite/mutations` `MutablePropertyView` so legacy STEP property
    edits mirror to the Y.Doc whenever a collab session is bound. The
    view's existing observers / change-set tracking still fire; reads
    pass through. `resolveEntity(id)` translates numeric expressIds to
    IFCX paths; returning `null` skips the mirror for that mutation.
    `PROPERTY_TYPE_NAMES` maps `PropertyValueType` enum values to the
    IFCX type strings stored on `PropertyValue`.
  - **`mountPresenceInViewer({ session, container, viewport })`** (spec
    §7 viewer mount): one-line glue that creates a presence overlay,
    forwards `mousemove → setCursor2d`, and returns a `teardown()`.
  - **`runPerfBenchmarks(budget?)`** (§15): self-contained Node-runnable
    benchmarks measuring single-attribute update size, cold-load time
    for a 1k-entity fixture, and (gated by `COLLAB_BENCH_HEAVY`) state-
    vector size at 100k entities. Each result reports
    `{ name, value, unit, budget, ok }`. Useful for `vitest` perf
    regression coverage and CI smoke tests.

  `@ifc-lite/collab-server`

  - **Per-section locks (open #7).** `createPathLockRegistry()` →
    `add({ prefix, label?, exemptUserIds?, exemptRoles? })` /
    `remove(lock)` / `matches(path, principal)` / `clear()`.
    `verifyAgainstPathLocks(registry)` returns a `VerifyMessageFn`
    that decodes incoming sync-update frames, runs them through a
    throwaway Y.Doc to harvest touched paths, and rejects writes that
    intersect any locked prefix (audit reason `locked:<label>`).
    `harvestUpdatePaths(update)` is exposed for tests + custom
    filtering. Path format: `entities/wall`, `geometry/g7`, etc.
  - **`startSecureCollabServer(opts)`**: bundles `createSecureHttpServer`
    - `secureHttpHandler` + `startCollabServer` so deployers get
      TLS-in-process plus the OWASP-baseline header wrapper without
      writing the wiring.

  Tests added (+11): mutations bridge happy path / null-resolve / delete
  mirror, path-lock registry add/match/remove + path harvesting + raw-WS
  rejection of writes to a locked prefix, perf benchmarks for
  single-attr-update / cold-load / runPerfBenchmarks happy paths,
  secure-bundle smoke test (rejects missing cert paths), viewer-bridge
  overlay mounting + mousemove forwarding + clean teardown via a
  hand-rolled DOM stub.

  Plan doc: v0.1 ☑ (mutations bridge added), v0.2 ☑ (mount-in-viewer
  shipped), v0.5 ☑ (TLS bundle + per-section locks). Open problems are
  closed in this batch as follows: problem #7 (per-section locks) is
  new in this PR; problems #1, #2, #3, #4, #5, #6, #8, #9, #10 were
  already closed in prior batches.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Big reach-for-the-stars batch. Closes (or near-closes) the remaining
  substantial items in `docs/architecture/collaboration.md` for v0.2,
  v0.5, v0.7, and v1.0. **+21 tests, total 140 passing.**

  `@ifc-lite/collab`

  - **History sidecar (v0.7).** `HistorySidecar` interface with
    `MemoryHistorySidecar` ship and an `AutomergeHistorySidecar` slot
    reserved (matching the same interface). Records, time-travels, diffs
    per-entity-id, branches, merges. `attachHistorySidecar(session,
sidecar, opts)` drives a sidecar from a live `CollabSession` on a
    configurable interval + on demand, with optional differential
    layers in each entry for cheap diff queries.
  - **End-to-end encryption (v1.0).** WebCrypto-based suite:
    `deriveRoomKey` (PBKDF2-SHA256, 200k iterations default),
    `generateRoomKey` / `exportRoomKey` / `importRoomKey`,
    `encryptFrame` / `decryptFrame` with versioned
    `[1B ver][12B IV][N B AES-GCM]` framing, and a `KeyRing`
    (`createKeyRing(initial, { gracePeriodMs })`) so in-flight frames
    decode through retired keys for the configured grace window.
  - **Presence-renderer math (v0.2).** `peerVisuals(peers, opts)` turns
    a `PresenceMap` into render-ready `{ color, label, opacity,
isStale, cursor3d, cursor2d, selection, modelId }`. Color resolution
    uses `colorForUser` against either the human or agent palette
    depending on the `(agent)` suffix; opacity fades over `staleAfterMs`.
    `cursorScreenPosition` projects 2D cursors per viewport.

  `@ifc-lite/collab-server`

  - **S3 persistence (v0.5).** `S3Persistence` against an injectable
    `S3LikeClient` + `S3Commands` shape — AWS SDK, R2, MinIO, or any
    S3-compatible client all fit without forcing
    `@ifc-lite/collab-server` to depend on `@aws-sdk/client-s3`.
    Per-room layout: `<prefix><room>.snap` for compacted state plus
    `<prefix><room>.log/<NNNNNNNNNN>.bin` for rolling log frames.
    Implements load / append / compact / drop with `frameMaxBytes`
    enforcement.
  - **Anti-replay wired into the message path (v0.5 / open #8).**
    `RoomOptions.verifyMessage: VerifyMessageFn` runs before rate-limit
    / role-check. Rejects audit as `reject` with the supplied reason.
    `verifyWithReplayProtector(protector, { requireSigned })` adapts the
    existing `ReplayProtector` for the hook. `encodeSignedFrame` /
    `decodeSignedFrame` ship a default
    `[0xff][4B clientId][4B clock][64B HMAC][N B payload]` envelope so
    apps don't have to invent one.
  - **TLS / secure-server helpers (v0.5).** `createSecureHttpServer`
    with strong defaults (TLS 1.2+, conservative cipher list, ALPN
    `http/1.1`, optional CA bundle for mTLS), `applySecurityHeaders` for
    the OWASP-baseline response headers (HSTS, no-sniff, frame deny,
    no-referrer), and `secureHttpHandler(inner)` to wrap an existing
    request handler with the headers + TRACE/TRACK rejection.

  Tests added (+21):

  - `history` — record / list / time-trace, diff added/removed/changed,
    branch + merge, session-driven captures with diff entries.
  - `e2e-encryption` — derive → encrypt → decrypt round-trip,
    cross-salt rejection, wrong-key rejection, export/import preserves
    decryption, key ring grace period, post-grace key drop.
  - `render` — color/label/opacity resolution, stale fading, local-peer
    exclusion, cursor projection by viewport.
  - `replay-wired` — server rejects unsigned frames when
    `requireSigned`, signed frame decodes + clock-tracks, replay
    rejected.
  - `secure-server` — security headers applied, TRACE/TRACK rejected
    via raw socket (undici blocks TRACE client-side).
  - `persistence-s3` — append + load round-trip, compact replaces snap
    and clears log, drop removes everything.

  Plan doc has updated v0.2 / v0.5 / v0.7 / v1.0 status badges. v0.5
  and v0.7 and v1.0 are now ☑ on every item that lives inside these
  two packages; remaining work for v0.5 (Redis persistence,
  full-bucket histograms) and v0.7 (`AutomergeHistorySidecar`) is
  opt-in extension that doesn't block GA.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Tackle-everything batch. Closes the remaining substantial items in the
  plan for v0.2, v0.3, v0.4, v0.5, v0.7, and v1.0. **+37 tests, total
  164 passing.**

  `@ifc-lite/collab`

  - **`AutomergeHistorySidecar`** (v0.7): real `@automerge/automerge`
    3.x implementation. Same `HistorySidecar` interface as the in-memory
    variant; adds binary `save()` / `load(bytes)` for
    cross-restart persistence. Branches and merges round-trip through
    the Automerge doc.
  - **`buildBranchTree(sidecar)`** (v0.7): pure-data branch-tree
    builder. Returns `{ nodes, edges, branches }` with `branch-anchor` /
    `entry` / `merge` node kinds and `history` / `fork` / `merge` edge
    kinds. Apps render this directly into git-log columns or
    force-directed graphs.
  - **Parametric mesh primitives** (v0.3): pure-TS reference kernel.
    `paramsToMesh(source, params)` ships `extruded-area-solid`, `box`,
    `cylinder`, and `revolved-area-solid`. `hashMesh(mesh)` returns a
    32-hex content hash for cache keys.
  - **Determinism harness** (v0.3 / open #5):
    `runDeterminismHarness(kernel, fixtures, expected)` + a
    `DEFAULT_FIXTURES` set covering every primitive. CI runs this on
    every platform and fails on drift.
  - **`createWebRtcProvider`** (v0.2 §8.1): wraps `y-webrtc` lazily so
    consumers who don't use it pay no bundle cost. Same status /
    whenSynced shape as the websocket provider.
  - **`createNumericRegistryAdapter(registry)`** (v0.4): bridges the
    renderer's existing numeric-offset `FederationRegistry` into our
    string-shaped `FederationResolver` without forcing
    `@ifc-lite/collab` to depend on the renderer.
  - **`installIfc4ToIfc4x3Migration()`** (v1.0): sample registered
    schema migration that renames `Pset_<…>::<key>` attributes into
    the `bsi::ifc::v5a::Pset_<…>::<key>` namespace. Demonstrates the
    migration plumb for consumers.
  - **`createPresenceOverlay({ container, viewport })`** (v0.2): drop-in
    2D canvas overlay that consumes a `PresenceMap` and draws other
    peers' cursors + label badges. `update(peers)` redraws; auto-resizes
    via `ResizeObserver`. Pairs with `peerVisuals` for any DOM viewer.

  `@ifc-lite/collab-server`

  - **`RedisPersistence`** (v0.5): `Persistence` against a
    `RedisLikeClient` interface (ioredis / node-redis 4+ satisfy it).
    Layout: `<prefix><roomId>:snap` for compacted state, list
    `<prefix><roomId>:log` for rolling frames. Implements
    load / append / compact / drop.
  - **Bucketed histograms** (v0.5): `MetricsRegistry.bucketedHistogram(
name, buckets, help)` accumulates observations into upper-bound
    buckets and renders as a proper Prometheus `histogram` type with
    `le="<bound>"` bucket labels.

  Tests added (+37): Automerge sidecar record / save+load / diff /
  branch+merge; branch-tree anchor + history edges, fork edges, merge
  edges with merge-from-branch annotation; parametric primitives shapes

  - deterministic hashes + dispatch errors; determinism harness happy
    path + drift detection; numeric registry adapter forwarding + numeric
    guard; IFC4 → IFC4X3 sample migration verifying renames; Redis
    persistence append/load + compact/clear + drop; bucketed histograms
    counts + label dimensions + empty-bucket guard.

  Plan doc: v0.2 ☑ (overlay shipped), v0.3 ☑ (parametric kernel +
  determinism harness), v0.4 ☑ (numeric registry adapter), v0.5 ☑
  (Redis + bucket histograms), v0.7 ☑ (Automerge sidecar + branch
  tree). v1.0 was already ☑; the sample migration finishes the §1.x
  "actually IFC schema migrations" caveat.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - `@ifc-lite/collab` follow-up: deterministic per-user color hash exposed
  publicly (`colorForUser`, `DEFAULT_USER_PALETTE`, `fnv1a`) and consumed
  automatically by `Presence.setUser` when the caller doesn't supply a color.
  `UserIdentity.color` is now optional.

  Conflict detector tightened: only flags concurrent deletes (not creates) at
  the entity top level, and now also surfaces concurrent Pset-creation as a
  `pset-property` event keyed by Pset name.

  `@ifc-lite/collab-server` follow-up: an append-only audit log
  (`AuditSink`, `MemoryAuditSink`, `noopAuditSink`, `shortHash`) that records
  `(timestamp, user, room, op-type, op-hash)` for every connect, sync,
  update, awareness, and reject event; and a per-peer rate limiter
  (`createRateLimiter`, `RateLimitOptions`) wired into the room's update
  filter. Editor-or-better roles get a 200-token / 60-tps default bucket;
  `startCollabServer` accepts a function form so service accounts can have
  tighter budgets than humans.

  Tests added: 23 new (color, audit + rate limit, disconnect/reconnect,
  property-based convergence with seeded random traces, conflict scenarios
  for each `ConflictKind`, broader entity-op coverage). Total now 49.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - v0.1 Foundation of `@ifc-lite/collab` — real-time collaborative BIM via CRDT
  on IFCX, plus a reference websocket sync server. New packages.

  `@ifc-lite/collab` ships:

  - Y.Doc schema with `entities` / `relationships` / `geometry` top-level
    shared types and helpers for every operation in the spec §6 table
    (create, delete, set attribute, set Pset property, hierarchy move, type
    promotion, relationship target add/remove, geometry param/blob updates).
  - IFCX seed (`seedFromIfcx`) and snapshot (`snapshotToIfcx`) with full
    round-trip against the buildingSMART hello-wall fixture.
  - Per-user layer extraction filtered by `clientID`.
  - IndexedDB and websocket providers, plus an in-memory provider for tests.
  - Awareness / presence helpers (3D + 2D cursors, selection, camera, view,
    section, isolation, tool, status) at 30 Hz with stale eviction.
  - Y.UndoManager wrapper scoped to a local-origin tag, so a peer's `undo()`
    only rolls back their own edits.
  - Conflict detector backed by `Transaction.changed` (catches LWW losses
    even when `YEvent.keys` is empty).
  - `createCollabSession` glues the above into the public façade documented
    in spec §16.2.

  `@ifc-lite/collab-server` ships:

  - `y-websocket`-compatible sync (`y-protocols/sync` + awareness on the
    same socket).
  - In-memory and append-only-file persistence with periodic compaction.
  - JWT auth hook (`AuthenticateFn`) and role-based write capability check.
  - Healthcheck endpoint and clean shutdown.
  - `ifc-lite-collab-server` CLI binary.

  Tests cover schema round-trips, the buildingSMART hello-wall fixture,
  two-peer convergence with conflict-detector firing on both peers,
  end-to-end sync through the websocket server, undo isolation, and
  per-user layer extraction.

  See `docs/architecture/collaboration.md` for the v0.1 → v1.0 roadmap.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the v0.1 → v1.0 plan. Lands foundational pieces of v0.3
  (geometry), v0.4 (federation), and v0.6 (MCP) so each upstack consumer
  has stable shapes to build on.

  `@ifc-lite/collab`

  - Blob store: content-addressed put/get/has/delete/list with a stable
    32-hex `fnv128` hasher. Backends: `MemoryBlobStore`,
    `createIndexedDbBlobStore` (browser only, lazy-loaded), `HttpBlobStore`,
    and `LayeredBlobStore(local, remote)` for local-first read-through and
    parallel write-through.
  - CSG-tree CRDT: `ensureCSGTree`, `appendCSGOp`, `insertCSGOp`,
    `removeCSGOp`, `moveCSGOp`, `getCSGOps`. Stored as `Y.Array<CSGOp>` on
    the geometry node's `params.ops` so concurrent appends interleave
    per-peer-relative-order. Order-dependence of the resulting solid is
    documented as a v0.1 limitation; full CRDT-tree merging is open
    problem #4 (v1.x).
  - Conflict UI bridge: `createConflictUIBridge(detector)` folds detector
    events into stable `(kind, path, field)` buckets and emits
    `open` / `update` / `close` lifecycle events. Buckets close on
    idle (`closeAfterMs`, default 4 s) or via explicit `resolve(key)`.
  - Agent presence helper: `markAsAgent`, `agentIdentityFromMcp`,
    `AGENT_PALETTE`. Standardized convention so the viewer can render MCP
    tool peers with a `(agent)` suffix and a distinct color band.
  - `FederationSession` (spec §10): hosts N per-model `CollabSession`s
    plus a shared `_federation` Y.Doc for cross-model
    `FederationRecord`s (clash, RFI, view, BCF refs). Presence is
    project-scoped via the `_federation` doc per §10.2. APIs:
    `createFederationSession`, `addModel`, `removeModel`, `upsertRecord`,
    `getRecord`, `removeRecord`, `listRecords`, `observeRecords`.

  `@ifc-lite/collab-server`

  - Blob HTTP route: `PUT /blobs/<hash>`, `GET /blobs/<hash>`,
    `HEAD /blobs/<hash>`, `DELETE /blobs/<hash>`, `GET /blobs` (list).
    Pluggable `ServerBlobStorage` (default `InMemoryBlobStorage`,
    swappable for S3/disk) and configurable `blobMaxBytes` (default
    100 MB) for payload-too-large rejection.

  Tests added (+22, now 71 total — all passing): blob store backends,
  CSG concurrent appends, UI-bridge open/update/close + explicit resolve,
  agent presence (suffix idempotence, deterministic id from MCP input),
  FederationSession (multi-model rooms, record CRUD, observeRecords), and
  the server's blob route end-to-end (round-trip, malformed-hash 400,
  413 on payload-too-large).

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands the production observability stack (v0.5),
  blob GC (v0.3 / open #6), GDPR helpers (v1.0), and the worker-safe
  snapshot entry point (v0.1 deferred).

  `@ifc-lite/collab-server`

  - `SnapshotWorker`: periodic per-room IFCX export to a writable
    directory. `runOnce()` for tests / cron. Skips idle rooms by default;
    `includeIdle: true` covers them too. Adds `@ifc-lite/collab` as a
    dep so we can call `snapshotToIfcx` directly.
  - `MetricsRegistry` + Prometheus-text `/metrics` endpoint. Ships
    counter/gauge/lightweight-histogram. Built dependency-free so we can
    swap in `prom-client` later without API churn. Surfaces
    `collab_rooms`, `collab_room_peers{room}`, `collab_updates_total`,
    `collab_rejects_total{reason}`.
  - `RoomManager.setCounters({ update, reject })` so the server can
    inject metric counters without leaking the registry into the manager.
  - `createReplayProtector({ secret })` (open problem #8): HMAC-SHA256
    verifier for `(clientId, clock, payload)` envelopes with strict
    monotonic-clock enforcement. `computeHmac` is exported so non-Node
    clients can produce matching tags.

  `@ifc-lite/collab`

  - `BlobStore.stat(hash)` (optional): returns `BlobMeta` without
    downloading the bytes. Implemented for `MemoryBlobStore`,
    `createIndexedDbBlobStore`, and `HttpBlobStore` (HEAD).
  - Blob GC (open problem #6): `collectReferencedBlobHashes(doc)`,
    `planBlobSweep(store, referenced, { epochMs })`, `sweepBlobs(store,
decision)`. Walks every entity's `geometryRef.geomId` → resolves
    `blobHash`, also collects any 32-hex string in `geometry.params.*`
    so apps that store auxiliary refs in params survive.
  - GDPR helpers: `exportAndLeave(session, { snapshot, serverDelete })`
    snapshots to IFCX, marks presence offline, runs the optional remote
    hard-delete hook, then disposes. `redactAuthorMeta(session)` blanks
    per-entity `createdBy` / `lastEditedBy` for anonymised exports.
  - Worker-safe snapshot entry: new sub-export
    `@ifc-lite/collab/snapshot/worker` ships `runSnapshotWorker(self)`,
    a postMessage adapter that mounts a `(snapshot|seed)` request handler
    on a `DedicatedWorkerGlobalScope`. The pure `snapshotToIfcx` /
    `seedFromIfcx` helpers are also re-exported from this entry point so
    consumers that don't want the adapter still get a worker-clean
    surface.

  Tests added (+18, total 101 passing): blob GC end-to-end (collect →
  plan → sweep, plus epoch grace window), GDPR `exportAndLeave` happy
  path / hook ok / hook failure / `redactAuthorMeta`, snapshot worker
  postMessage round-trip (snapshot, seed, error report), server-side
  `SnapshotWorker` writing IFCX files, metrics counters / gauges /
  histogram and the `/metrics` endpoint serving Prometheus text, and
  replay-protector HMAC happy path / tampered MAC / replay / payload
  mismatch.

  Plan doc updated with v0.3 / v0.5 / v1.0 status badges.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands operational v0.5 pieces, the v0.7 branching
  starter, and v1.0 schema-migration scaffolding.

  `@ifc-lite/collab-server`

  - `JsonlFileAuditSink`: append-only NDJSON file sink with size-based
    rotation (`rotateAtBytes`) and an opt-in `fsync`-after-append mode for
    durable audit trails.
  - Idle room unloading: `idleUnloadMs` knob plumbed end to end. The
    manager runs an internal `unref()`'d sweep timer at half the idle
    window; `sweepIdle()` is also callable directly. Persistence keeps the
    durable copy, so unloading is non-destructive.
  - Retention policy: `planRetention(dir, policy)` + `applyRetention`.
    Honors `fullLogDays` (default 90), `snapshotsDays` (default 5y), and
    `maxBytesPerRoom` (trim oldest first). Pluggable file classifier so
    custom naming schemes work too.
  - `RoomManager.stats()` returns `(roomId, peerCount, idleMs)` triples
    for diagnostics and tests.

  `@ifc-lite/collab`

  - Schema-version helpers (open problem #2 prep): `getSchemaVersion`,
    `setSchemaVersion`, `registerSchemaMigration`, `migrateSchema`, plus
    a `MIGRATION_ORIGIN` symbol so observers can filter migration
    transactions out of e.g. undo stacks.
  - v0.7 branching starter: `forkSession(parent, { name })` snapshots the
    parent's Y.Doc, seeds a fresh sibling session, and stamps
    `meta.branch.parentRoomId` / `branch.name` / `branch.forkedAt`.
    `mergeBranch(parent, branch, strategy)` implements both `'ops'`
    (Y-update apply with last-write-wins on conflicts) and `'layer'`
    (IFCX snapshot + non-resetting re-seed). Returns a small
    `MergeReport`. `readBranchMeta` exposes the metadata back.

  Tests added (+12, total 83 passing): JSONL append + rotation, retention
  plan + apply (full-log days, snapshots days, maxBytesPerRoom),
  RoomManager idle sweep with both empty and busy rooms, schema-version
  round-trip + a sample migration that renames an attribute namespace,
  and end-to-end branch fork → divergent edits → merge for both strategies
  including a non-conflicting parent-edit-survives case.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands the differential layer composer (v0.7), the
  property unit converter (v1.0 / open problem #3), conflict resolver
  actions on the UI bridge, the `FederationResolver` interface, and the
  network-latency simulation perf harness (v0.2).

  - `extractMinimalLayer(doc, baseline, opts)`: produces an IFCX layer
    containing only the entities and fields that changed since
    `baseline`. Entities created since baseline are emitted whole;
    entities that already existed only get their changed attributes /
    children / inherits keys. Toggle whether updated values count as
    diffs via `includeUpdatedValues`.

  - `convertEntityUnits(doc, from, to)` walks every Pset and converts
    numeric `PropertyValue`s with a matching `unit`. Ships SI-relative
    scale tables for length (m/cm/mm/in/ft), area (m²/cm²/mm²/ft²/in²),
    volume (m³/cm³/mm³/L), and angle (rad/deg). `convertValue(value,
from, to)` is exposed for one-shot conversions. `familyOf(unit)`
    classifies a unit string.

  - Conflict UI bridge: `bridge.keepMine(key)` and `bridge.acceptTheirs(key)`
    run registered handlers (per `ConflictKind`) and close the bucket.
    Handlers receive `{ bucket }` and are responsible for emitting the
    follow-up CRDT edit.

  - `FederationResolver` interface: typed `toGlobalId / fromGlobalId /
getModelForGlobalId` contract. `passThroughResolver` is the default
    for IFCX UUID paths (globally unique by construction).
    `createMapBackedResolver(table)` covers explicit lookup tables. The
    renderer's existing numeric-offset `FederationRegistry` can be
    wrapped to satisfy the interface without forcing `@ifc-lite/collab`
    to depend on the renderer (adapter snippet documented in source).

  - `createLatencyChannel(a, b, { baseMs, jitterMs, dropRate, random })`
    wraps a pair of Y.Docs with a queued, time-bucketed update channel.
    `flushUntil(t)` advances simulated time and dispatches due updates.
    Useful for benchmarking the §15 perf budget under simulated network
    conditions.

  Tests added (+18, total 119 passing): minimal-layer round-trips and
  diff-only behaviour, unit conversion across families plus skipping on
  mismatched unit, bridge `keepMine` / `acceptTheirs` lifecycle including
  follow-up CRDT writes from handlers, resolver pass-through and
  map-backed lookups, latency channel arrival-time behaviour and
  deterministic drop rate under a seeded PRNG.

## 0.1.0

### Minor Changes

- Initial release. v0.1 Foundation per `docs/architecture/collaboration.md`:
  - Y.Doc schema with `entities`, `relationships`, `geometry` top-level maps.
  - IFCX seed (`from-ifcx`) and snapshot (`to-ifcx`) round-trip.
  - Per-user layer extraction.
  - IndexedDB and websocket providers.
  - Awareness / presence helpers (3D + 2D cursors, selection, camera).
  - Y.UndoManager wrapper scoped to local origin.
  - Conflict detector + UI-bridge event emitter.
  - `createCollabSession` public API binding the above together.
