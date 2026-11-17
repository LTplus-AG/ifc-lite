# Viewer CPU Geometry After Upload

Status: measurement and audit for [#10264](https://github.com/LTplus-AG/ifc-lite/issues/10264), stage S0. Nothing here changes viewer behaviour. Code references are to `main` at the commit this page was added with.

The viewer keeps the CPU copy of every flat mesh (`positions`, `normals`, `indices`) after the geometry is on the GPU. This page records how much that is, who holds it, what the dormant release path behind `boundedGeometryMode` would do if it ran, and which code reads the store's mesh list.

## The figure: CPU geometry held

`__ifc_lite_cpu_geometry_held__()` (installed with the other viewport debug hooks in `apps/viewer/src/lib/viewport-debug-hooks.ts`) walks the typed-array geometry and index buffers held by the listed store, scene, and raycast-index owners. It includes streaming `fragmentPieces` and `streamWork` arrays under `scene.fragmentPieces` and `scene.streamWork`; transient records are released at finalize; built-batch snapshots remain counted until their batch records retire. It returns:

| Field | Meaning |
|---|---|
| `totalBytes` | `byteLength` of each distinct underlying `ArrayBuffer`, counted once. A worker-batch arena viewed by hundreds of meshes counts once, at its full size. The store mesh and the scene's shallow copy of it share arrays and count once. Released (zero-length) and detached arrays count zero. |
| `owners[name].reachableBytes` | Distinct buffer bytes reachable from one holder. |
| `owners[name].exclusiveBytes` | Bytes reachable from that holder only: what letting go of that holder alone would free. |
| `sharedBytes`, `byKind`, `buffers`, `walkMs` | Bytes reachable from more than one holder; split by positions / normals / indices / other; buffer count; walk time. |

Holders: `store.models`, `store.geometryResult` (when it is a separate list), `store.preAlignment` (a copy kept for georeferenced federated models), `store.removedMeshes` (the delete-undo stash), `scene.buckets`, `scene.meshDataMap`, `scene.meshQueue`, `scene.instancedTemplates`, `scene.textured`, `scene.fragmentPieces` (transient whole and split pieces), `scene.streamWork` (recorded run meshes, captured bytes and colour salts), `pick.raycastIndex` and `pick.bvh`. The renderer side is `Renderer.visitCpuGeometry(visit)`, which hands out views and never copies.

The count includes typed-array geometry and index bytes only. The renderer raycast BVH's typed-array buffers are visited as `pick.bvh` (`other`). The `@ifc-lite/spatial` BVH holds JavaScript objects with bounds per mesh and ordinary arrays, no geometry arrays; it is not counted. Capture-armed bytes held weakly before a fragment is recorded are not visited.

Cost: nothing unless the hook is called. It is loaded on first call by a dynamic import, and no frame, load or pick path calls it. One call walks every mesh once and keeps a map with one entry per distinct buffer. Measured below: 2 to 8 ms over 27 to 66 buffers.

`scripts/perf/oom-load-probe.mjs` records the figure every fifth page poll (`cpuGeometryHeld` rows in `samples.ndjson`), and once 3 s after the load is interactive (`result.cpuGeometryHeld`, with `settledPssMiB`, the summed PSS of all Chrome processes at that moment). A viewer without the hook records nothing.

## Measurements

One run each, untimed. Synthetic files from `scripts/perf/gen-dense-ifc.mjs` (seed 1). Probe at declared 16 GB and 8 cores, 20 GiB cap (never reached), headed Chrome on a discrete NVIDIA GPU, so GPU buffers are not charged to process memory. The host ran at a 45 W package limit and a 60 % frequency ceiling; no timing here is meaningful.

| File | Triangles | CPU geometry held (settled) | Bytes / triangle | Summed PSS settled | Share of settled PSS | Peak PSS | Walk |
|---|---:|---:|---:|---:|---:|---:|---:|
| `tfs` 150 MB | 6.10 M | 488 MiB | 83.9 | 1,674 MiB | 29 % | 2,999 MiB | 6 ms |
| `tfs` 600 MB | 24.38 M | 1,951 MiB | 83.9 | 3,555 MiB | 55 % | 5,115 MiB | 8 ms |
| `brep` 600 MB | 3.76 M | 301 MiB | 83.9 | 2,421 MiB | 12 % | 4,113 MiB | 2 ms |

In all three runs, every held byte was reachable from both `store.models` and the scene (`scene.buckets` and `scene.meshDataMap`), and every holder's `exclusiveBytes` was 0. So **neither side can free anything on its own**: the store list and the scene's shallow copies pin the same buffers. The raycast index held nothing because no pick had run yet; it builds lazily on the first ray. Positions and normals are 43 % of the bytes each, indices 14 %.

"Settled" means 3 s after interactive, without a forced garbage collection. The rest of settled PSS is the tab baseline (about 0.6 GB), the shared source buffer and the geometry worker's WASM heap (see the attribution in #10264). The triangle-dense `tfs` file is the case where the CPU copy dominates.

## The dormant release path

The viewer has two scene-side release entry points and a separate store-side release:

- **Ephemeral path** (the one the viewer wires): `Scene.setEphemeralStreamingMode(true)` before streaming, `finishEphemeralStreaming()` at stream end, then `onGeometryReleased` calls the store's `releaseGeometryMemory`, which calls `releaseCpuMeshBuffers` (`apps/viewer/src/lib/geometry-cpu-release.ts`).
- **Explicit path**: `Scene.releaseGeometryData()` after a normal finalize. Only tests call it.

**Nothing can turn either on today.** `setBoundedGeometryMode` has one caller, with `false` (`useIfcLoader.ts`). `ViewportContainer.tsx` passes `releaseGeometryAfterStream={false}` as a literal, and the embed viewer omits it (default `false`), so `useGeometryStreaming` always calls `setEphemeralStreamingMode(false)` and the branch that calls `finishEphemeralStreaming` and `onGeometryReleased` is unreachable. There is no URL flag, environment variable, setting or size condition. The enabling calls were removed on 2026-06-07 with the desktop app (#992) and the single load path (#975).

### What it would free

The store release and the scene release are gated separately: the store side by `boundedGeometryMode`, the scene side by the Viewport prop. Because the scene keeps shallow copies of the store's meshes, both must run before any buffer is freed. Turning on only the prop would save nothing.

When both run, these are freed: the store's `positions`, `normals` and `indices` and the `appearanceSource` index arrays of the active model's meshes, on every registered alias too; the scene's `meshDataMap`, buckets, partial-batch caches, fragment pieces and residency state; and the instanced templates' CPU positions, normals and indices.

These are not freed:

- meshes of non-active federated models, because only `state.geometryResult.meshes` is walked;
- `uvs` and `entityIds`;
- textured meshes' `positions`, which `texturedSources` holds strongly;
- instanced `instanceData`;
- `FederatedModel.preAlignment`, a copy;
- after `releaseGeometryData` only, the snap detector's cache.

### What breaks when it runs

| Area | Behaviour after release |
|---|---|
| **Hide / isolate / storey isolation** | **Visible elements disappear.** A partly visible batch always gets a sub-batch request. Only the X-Ray and promotion splits check `canPartitionBatch`. The parent batch is then skipped (`renderer.ts`, after `pushVisible`). After release, `getOrCreatePartialBatch` returns `undefined` and `if (subBatch)` draws nothing. So every visible element that shares a batch with a hidden or non-isolated element vanishes, and its shadow goes too (`shadow-occluder-batches.ts`). Flat geometry has no per-entity visibility in the shader; only instanced geometry has a flag discard (`shaders/main.wgsl.ts`). The design note's guess that hidden elements would show was wrong. |
| X-Ray, fully visible batch | Drawn whole at the lowest alpha of its ids: faded too much, nothing missing. X-Ray combined with hiding vanishes like plain hiding. |
| Click / hover pick | GPU pick bypassed; bounding-box raycast only, so a large box in front steals the pick. On the ephemeral path flat entities never enter `meshDataMap`, so they get **no** box and cannot be picked at all. Rect select is box-only without depth. |
| Selection / hover highlight (flat) | `getMeshDataPieces` returns nothing: silently no highlight. Instanced and textured highlights still work. |
| `updateMeshColors` | Skipped with a warning. Lens / IDS overrides still work through the GPU colour table. |
| Device loss | Recovery refuses with `cpu-geometry-released`; the model has to be reloaded. |
| GPU / host residency, cold restore | Return early. |
| Instanced appearance edits | Throw. |
| Measure, snap | No target, null hit. |
| Section caps, 2D drawings, export, clash | Read the store's empty arrays: empty or zero-triangle output, a silent wrong answer (inferred, not traced line by line). |
| Collab seed, symbolic fills, entity world position | Explicit guards: skip and report, or null. |

No viewer code checks `isGeometryDataReleased()`; only renderer-internal guards react to a release.

## Who reads the store's mesh list

The design note classified "about 60" further readers from one line each. Reading them properly finds **140 non-test files** that read the store's mesh list directly, through a helper, or downstream:

| Class | Files |
|---|---:|
| Identity / metadata / counts only | 36 |
| Reads `entityIds` (per-vertex ids of colour-merged meshes) | 9 |
| Positions for bounds or centres | 28 |
| Positions and indices for geometry work | 23 |
| Passes the list on | 26 |
| Writes or copies arrays | 18 |

Corrections to the design note's inventory table:

- **Colour overrides (row 6).** Embed-host overrides go through the store's `updateMeshColors`, which maps the whole list into `{...mesh, color}` copies. It reads no arrays and is release-aware.
- **Measure (row 12).**
  - `measure-modes/min-distance.ts` has no importer: it is dead code.
  - The selection quantity summary sums every triangle of every model whenever the quantities panel is mounted and any model changes, not once per selection. With empty arrays it reports 0 m² as a complete measurement.
- **2D drawings (row 14).** `useDrawingViewModel.ts` reads only colour. `plan/usePlanCut.ts` is a second drawing producer that the row did not list.
- **Id-only readers (row 27).** Ten files actually read `entityIds`, so a release would silently change their result. They feed hidden-entity sets, the empty-view notice, storey ghosting, appearance scope, level arrival, reposition picking, and the "mesh hosts other entities" check used by delete, prune and remesh. Three readers listed there use bounds: compare's `describeChange`, `exportReport`, and report snapshots.
- **Spatial index, federation, RTC, rotation (row 18).**
  - The RTC rebase moves `origin`, not `positions` (`packages/geometry/src/rtc-rebase.ts`).
  - The in-place rotation rewrite is `rotation-geometry.ts`; `rotation-bake.ts` makes a copy for the undo stash.
  - Entity world position runs once per Lists cell render.
  - The spatial index rebuilds after load and after every placement settle, and materialises every GPU instance each time.
- **Mutation (row 22).**
  - Missed `Scene.translateFlatMeshesForEntity`, which moves the typed arrays the store shares in place.
  - `useMeshEditDrain` re-uploads from the store list, not from scene pieces.
- **Zones, walk, rooms (row 25).** Walk mode and zone pieces read scene pieces; rooms read the store list.
- **Pruning (row 28).** The code is at `data-mesh-prune.ts:103-130`; it also reads `entityIds`.
- **Bounds and framing (row 26).** These also fire on every orbit press and every selection; see the next list.
- **"How the copy is held".** The note says there is one copy. In fact, georeferenced federated models also keep `preAlignment`, a deep copy of positions and normals (24 B/vertex), grown with every streamed batch. The embed viewer and `useFederatedGeometry` keep further shallow copies.

Readers the note missed that run during plain viewing:

- `PropertiesPanel.tsx`: on every selection, scans all meshes and folds the selected entity's positions into a centre. Empty arrays give Infinity or NaN, with no guard.
- `useMouseControls.ts` (orbit press with a selection and no hit), `GizmoOverlay.tsx` (selection with editing allowed), keyboard and space-mouse framing: these fall back to null or to scene boxes.
- `useGeometryStreaming.ts`: a `geometryContentVersion` bump re-uploads the whole scene from the CPU arrays. Bumps come from federation realign, RTC rebase, model rotation, collab apply and federation adds. With empty arrays the model disappears.
- `robustFitBoundsAccumulator.ts`: reads the positions of every streamed mesh, and rescans everything when the list object changes.

Other holders of typed geometry arrays on the main thread, beyond the store list and the scene:

- **Copies:**
  - `preAlignment`;
  - the rotation baseline, while a model is rotated;
  - the `removedMeshes` undo stash;
  - appearance scan sessions;
  - room-geometry leases;
  - instanced occurrences materialised for export, clash, PDF and the spatial index (transient);
  - the reopen cache's decoded-chunk LRU;
  - the Cesium GLB cache.
- **References that pin meshes:**
  - the loader's `allMeshes` (cleared 5 s after finalize) and `cacheMeshes`;
  - `scene-precision.ts`'s `TopologyMemo`, which keeps strong `MeshData` keys;
  - the collab reconstruct cache.

The figure counts the store list, `preAlignment`, `removedMeshes`, the scene holders (including `scene.fragmentPieces` and `scene.streamWork` while streaming) and the raycast index. It does not count the transient and tool-scoped holders above, or JavaScript heap structures such as `store.spatialIndex`. An S4 release that empties the store and scene arrays would leave all of them in place.

## Host eviction on a reopened model

The design note inferred that host-tier eviction frees nothing, because the store keeps its own references. One measurement settles it.

**Setup (one run, untimed).**

- A synthetic `tfs` 120 MB file: 2,209 meshes, 390 MiB of geometry.
- Loaded once, so the reopen cache was written. The page was then reloaded in the same profile and the file opened again: a cache hit, so the cold provider was installed.
- GPU and host budgets set to 32 MB through the `__IFC_LITE_GPU_BUDGET_MB` / `__IFC_LITE_HOST_BUDGET_MB` globals.
- The camera was zoomed into one corner so the GPU tier evicted, and then the host tier.
- Each reading ran a forced GC first.

| Point | CPU geometry held | `scene.buckets` reachable | `store.models` exclusive | Scene bucket bytes (`render_stats.cpuBytes`) | JS heap | Summed PSS |
|---|---:|---:|---:|---:|---:|---:|
| First load, settled | 390 MiB | 390 MiB | 0 | 390 MiB | 711 MiB | 1,517 MiB |
| Reopen, settled | 400 MiB | 400 MiB | 0 | 390 MiB | 964 MiB | 1,531 MiB |
| After host eviction | **400 MiB** | 55 MiB | **345 MiB** | 54 MiB | 452 MiB | 1,164 MiB |

The host tier did evict: the scene let go of 336 MiB of bucket geometry, and the console reported the budget still exceeded by hot buckets. **But `totalBytes` did not move.** The same buffers became exclusive to `store.models`. So the inference is confirmed: **host eviction frees no geometry**, because the store's mesh list keeps every array the scene drops. A restore then decodes a second copy from the cache entry.

The JS heap and PSS did fall after the first zoom round, by about 510 MiB and 370 MiB. That is not geometry, since the figure shows the same buffers still referenced; this run does not say what it was. The extra 9 MiB on reopen is held by both the store and the scene.

For S7 this means the store must learn about evictions (or stop holding the arrays) before the host tier saves anything.

## What stage S1 needs from this

S1 (GPU pick that draws the existing batches) is the first consumer to move off the CPU copy. From this audit:

- Use `__ifc_lite_cpu_geometry_held__` as the acceptance figure for every later stage. A release only counts when `totalBytes` falls, not when one holder's `reachableBytes` falls.
- On the ephemeral path flat entities have no world box at all, so S1 cannot fall back to box picks there. It must answer from the GPU, or S4 must keep per-entity boxes.
- The pick lane carries the entity, not the representation item (`geometryItemId`); item-level picks need the open question in the design note answered.
- Hide / isolate (S2) is the stage that must land before any release: today's failure mode there is visible geometry disappearing, which is worse than the note assumed.

Probe diagnostic status: samples and settled results report cpuGeometryMeasurement as available, unavailable (viewer has no hook), error (with a diagnostic message), or timeout. A failed walk is never silently treated as an absent hook. scene.fragmentPieces includes retained built-batch snapshots and its drawn-mesh memo, even when a bucket no longer holds those arrays.

## Stage S1: GPU pick from the batches

Picks on models over the pick-mesh budget, and on scenes whose CPU geometry was released, now draw the colour batches whole instead of taking the CPU raycast (see [Pick routes](rendering-pipeline.md#pick-routes)). The route reads the entity from the vertex lane, hide/isolate from a GPU id table, and the hit point from depth under the pass's camera-relative snapshot. This covers click, hover and rectangle select.

What still reads the CPU copy on this route, and why:

- **The representation item.** The lane carries the entity only. A model that keeps its CPU geometry raycasts the picked entity alone (its flat pieces and any instanced occurrences) along the same texel-centre ray, so `modelIndex` and `geometryItemId` match the CPU route. A released scene reports the entity and its model index (from the batches' own entries), as the design decisions allow until a local spill exists.
- **The fallback.** When the batches cannot answer for every drawable (pending rebuild, finalize, an evicted batch on the ray, ids outside the lane range, missing pipelines), the whole pick takes the CPU raycast. A released scene then still has only the box raycast; on the ephemeral path that can miss flat entities, as recorded above.

S1 frees nothing: release stays disabled, and hide/isolate (row 4) and highlight (row 5) still read the pieces. `__ifc_lite_pick_parity__({ columns, rows, rect? })` compares the GPU pick with `raycastScene` over a texel grid under the current visibility; `tests/e2e/gpu-batch-pick.e2e.spec.ts` runs it on public fixtures on a real adapter.

## Stage S2: hide and isolate from the batches

The "Hide / isolate / storey isolation" row above no longer applies. A partly hidden colour batch is drawn whole from its own GPU buffers and the GPU discards its hidden entities, in the colour pass and the shadow pass, against the same id table the S1 pick reads (see [Batching Strategy](rendering-pipeline.md#batching-strategy)). No sub-batch is cut from the CPU pieces for visibility, for any model size, so a scene whose CPU geometry was released keeps drawing and casting the visible batchmates. `renderer-render-paths.test.ts` pins this with the scene released; `tests/e2e/gpu-entity-visibility.e2e.spec.ts` compares the real frame with the frame of the visible pieces alone on public fixtures.

What S2 does not change, and what still reads the CPU copy:

- **X-Ray and lens promotion** still split a batch into per-alpha subsets cut from its pieces while it can be partitioned (row 5 of the original table). Without pieces the batch draws whole under the visibility test at the lowest alpha of its visible entities: a fade that is too wide, never a missing or hidden entity.
- **Type visibility** (IfcSpace, openings, the Model/Types switch) is not hide/isolate: `useFilteredGeometry` drops those meshes from the list the scene uploads, so toggling a type re-uploads from the store's CPU arrays. It needs its own route before a release.
- **Selection and hover highlight** (row 5) still build per-entity meshes from the pieces; that is S3.
- **Colour-merged pieces.** Classification reads primary entries, as before S2. Partly visible batches test the vertex lane and hide secondary entities exactly. When every primary entry is visible, the test is skipped and a hidden secondary can remain drawn; when every primary entry is hidden, a visible secondary is dropped. No in-tree producer emits foreign per-vertex ids today, but hosts can supply them through `MeshData.entityIds`. [#10653](https://github.com/LTplus-AG/ifc-lite/issues/10653) tracks complete lane coverage before an in-tree producer emits foreign ids or CPU-geometry release is enabled for such host-supplied meshes.
- **Textured meshes** are drawn one per mesh and were already filtered without CPU geometry. Instanced occurrences keep their per-instance hidden flag.

S2 frees nothing and makes no speed claim; release stays disabled.
