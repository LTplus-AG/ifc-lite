# Pending GPU picks and viewport synchronization (#6882)

This is a correctness result, not a speed measurement. It unblocks a prerequisite
for navigation qualification; it neither explains the earlier spontaneous pick
miss nor resolves the private load-time regression in #6516.

## Observed defect and compiled-source result

The original one-shot GPU reproduction is retained in `before-fix/`: both held
navigation subjects discarded a pending pick after repeating the unchanged aspect
ratio. The camera pose, projection and CSS viewport were unchanged, and ordinary
picks before and after the intervention succeeded.

`compiled-qualification/` compares main `8046277433761542483d4260a140dd72123d63fc`
against that same source plus the #6882 production patch. Both viewer builds used
the identical CI WASM runtime with SHA-256
`a8216da63bd0d2eaa9652c91ce95a934268a080d6b35ed682910cc9e49824b02`.
The build receipts pin production-source hashes, and the compiled inventory pins
every served file. The observer imports the actual renderer from its Vite bundle;
it does not replace production methods or the canonical model-loading path.

Native Windows Chrome 154.0.8037.93 reported NVIDIA Blackwell WebGPU. Each fresh
context loaded public `AC20-FZK-Haus.ifc` first, with a fixed CSS-center pick and no
search or replacement samples. Primary loading used the file input; federation
used the canonical add-model input with a second copy of the same public model.

| Subject | Models | Ordinary picks stable | Repeated aspect | Actual aspect change | Proportional CSS resize |
| --- | --- | --- | --- | --- | --- |
| Main | 1 | yes | incorrectly discarded | rejected | incorrectly accepted |
| Fixed | 1 | yes | preserved | rejected | rejected |
| Main | 2 | yes | incorrectly discarded | rejected | incorrectly accepted |
| Fixed | 2 | yes | preserved | rejected | rejected |

Stable means equal `expressId`, `modelIndex`, `geometryItemId` and finite
`worldXYZ` within each context. It does not mean cross-context pixel identity.
Every completed model retained 317 meshes and 33,356 triangles; corrected
federation controls also checked each metadata store's 468 entities. All completed
rows had no page errors. The two overlapping models' sampled hit belongs to model
index zero; this is a two-model context check, not an exhaustive federation oracle.

## Preserved failures and limits

Attempt 1 retained both single-model rows and two federation observer timeouts.
That observer incorrectly required `loadState === 'complete'` on every model;
canonical federated finalization registers complete metadata and geometry without
that field. Attempt 2 declared this specific readiness correction before running
its two federation rows: exact known fixture counts, canonical registration,
global loading/streaming completion and drained GPU queues. Original timeouts
remain archived and are not counted as passing controls.

Baseline rows retain `passed: false` because they fail the proportional-resize
invariant. Both fixed rows pass every assertion. These are retained negative
controls, not omitted failures. The functional protocols use an explicitly
declared 8-GiB free-memory floor on each host. They do not claim CPU quietness or
change the held navigation timing protocol's 40-GiB/CPU/active-graph gates.

Root Turbo renderer tests passed 2,021 tests with two existing skips; full root
typecheck passed all 114 tasks and audited all 3,424 test files. With the new tests
retained and only both production files restored to unfixed main, the same root
renderer command failed 29 tests. Fixed source is restored in a `finally` block.
The source review checked every asynchronous picking path, including the mixed
CPU/GPU rectangle error fallback. Exact aspect equality is the only camera no-op;
scene republication still invalidates snapshots.

## Inventory and reproduction

Each directory's `manifest.json` records original and stored SHA-256 hashes.
JSON and logs are losslessly gzip-compressed with a fixed timestamp; PNGs are
unaltered. The compiled archive includes both declared protocols, actual scripts,
build configurations, source/build inventories, all results/admission receipts,
screenshots and validation logs. Paths in the scripts identify the original
machine and immutable attempt directories; adapt paths for a separate run rather
than overwriting these subjects.

The portable regression command is `pnpm test --filter=@ifc-lite/renderer` from
the repository root. For the viewer behavior, load the public house in a fresh
native-WebGPU viewer, start a point pick, synchronously call
`camera.setAspect(camera.getAspect())`, then await the original result. The fixed
viewer preserves it. A real camera-aspect change or an actual CSS viewport change
before the readback finishes must still reject that result.
