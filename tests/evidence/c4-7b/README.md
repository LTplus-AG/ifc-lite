# C4-7b fallback full-file work (#8341)

Base `51d6e067a5` (main after F2 #8350 and the C4 browser measurement #8361). Optional performance lane: PROCESSING-9 and
EDGE-WASM-12 fallback halves, PROC-AL-19.

## Fallback scans before and after

Extra whole-file `EntityScanner` passes beyond the pre-pass's own scan, per
`IfcAPI` and content. Keyword-gated passes run only when the keyword occurs.

| Path | Site | Base | Head |
| --- | --- | ---: | ---: |
| Worker (streaming), merge layers off | type plan, layer index | 0 (injected) | 0 |
| Worker, merge layers on | parts-to-skip | 2: ungated layer index + aggregates | 0, or 1 (aggregates) when something is sliceable |
| `buildPrePassOnce`, merge layers off | type jobs rescan (`IFCREPRESENTATIONMAP`) | 1 | 0 |
| | type plan (first type job in a batch) | 1 | 0 |
| | layer index (`IFCMATERIALLAYERSET`) | 1 | 0 |
| `buildPrePassOnce`, merge layers on | type jobs + type plan | 2 | 0 |
| | parts-to-skip | 2 | 0, or 1 when something is sliceable |

The worker merge-layers cost is paid by every geometry worker. Unchanged, for
lack of spans on the worker wire: the keyword-gated indexed-colour and texture
scans, and the aggregate walk itself when a sliceable buildup exists.

Mechanics: `PrepassColumns::build` (type-plan sets plus material-layer index
from scan spans) is the one construction both pre-passes use. The streaming
pre-pass flattens it onto the worker wire as before. `buildPrePassOnce` now
collects mapped-item and type-candidate spans in its single scan, plans its
type jobs from them and installs the columns on its own `IfcAPI`.
`compute_parts_to_skip` takes the caller's index and returns early when none
is sliceable. `collect_type_geometry_jobs` (the rescan) is deleted.

## Instruction counts

`measure.sh` copies one harness (`measure_tests.rs`) into a base export and the
head checkout, builds each release test binary, and runs each mode once under
callgrind 3.26.0, whole process. Cost = mode Ir minus its `-setup` twin (the
same setup without the measured call).

* `parts`: worker merge-layers first batch. The wire's entity and layer index
  are installed, then `get_or_build_parts_to_skip` runs.
* `once`: `buildPrePassOnce` plus one batch holding the first type-product job
  (none when the file has none), so every lazy fallback is reached without
  meshing the model.

| Fixture | parts base | parts head | ratio | once base | once head | ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| c4_native_unsliced_layers_7782 | 99,960 | 29,693 | 0.297 | 2,706,130 | 2,677,293 | 0.989 |
| 845_wall_elemented_case | 954,141 | 2,012 | 0.002 | 7,213,272 | 6,452,264 | 0.895 |
| AC20-FZK-Haus | 58,408,406 | 3,135 | 0.0001 | 204,749,052 | 117,263,712 | 0.573 |
| duplex | 54,014,229 | 26,475,340 | 0.490 | 162,326,176 | 109,672,922 | 0.676 |
| schependomlaan | 1,117,848,985 | 546,187,397 | 0.489 | 2,673,499,278 | 1,570,906,333 | 0.588 |
| sliceable wall with parts | 126,950 | 62,189 | 0.490 | 2,635,538 | 2,617,843 | 0.993 |

The last fixture is `merge_layers_skip_test.rs`'s sliceable wall (three parts
skipped on both sides). duplex and schependomlaan author sliceable buildups, so
head still pays the aggregate walk there. Haus and #845 have none and return
early.

Pop, source `547424c4b4`, request `auto-5ca3f5412d89443bae6355d2f2f9bb85`, job
`a83b244b-33d1-4379-a166-81a6bd364a12`. The pre-rebase run (base `1a3d4a83a7`,
source `16c79561f2`, job `78142cdf-f7bd-41d8-bffa-cb5dbb90d139`) agreed to within
0.1% per row and produced the same hashes.

```sh
~/build-workers/ifc-fleet run --host pop-os --storage-task c4-7b-fallback-r1 \
  --cwd /home/louistrue/.t3/worktrees/ifc-lite/t3-d14b75b8 -- bash tests/evidence/c4-7b/validate.sh measure
```

Scope: these are instruction counts for the fallback-reaching slice, not a
worker-pool wall-time or browser peak-memory result. No speedup claim beyond
the counted work.

## Output identity

The same job hashed (FNV over `Debug` of every mesh, finish, geometry
diagnostics and refusal counters) the full once path, all jobs, merge layers
off and on, plus the worker parts set, on base and head:

| Fixture | jobs | merge off | merge on | worker parts |
| --- | ---: | --- | --- | --- |
| c4_native_unsliced_layers_7782 | 1 | b314552a6cb53dde | 2c1b167fdc65c513 | 0 |
| 845_wall_elemented_case | 16 | f4dbd1f15b34f8b4 | f4dbd1f15b34f8b4 | 0 |
| AC20-FZK-Haus | 143 | e08031697306df76 | e08031697306df76 | 0 |
| duplex | 291 | 19087e565bd29b55 | 4624dd626de41512 | 0 |
| schependomlaan | 3,816 | 4bcd965faaf53793 | 780e16908857abfc | 0 |
| sliceable wall with parts | 4 | 4ae3d46bac9cb0e2 | 85c1591b8b1b9811 | 3 (21a4249615376e76) |

Every value is identical on base and head. The C4-0 parity gate is unchanged
(`batch_parity_expected.json` has no edits).

## Diagnostics note

On the once path, decode refusals of mapped items, type relationships and
material associations are now taken by the pre-pass decoder (as the streaming
path already did), not attributed to the first batch element. The hashed
refusal counters above did not move on these fixtures. With merge layers on,
the `[ifc-lite layers]` console diagnostic now prints as it already did with
merge layers off.

## Revert oracle

`behaviour.oracle.patch` keeps the shared columns and the test module, and
mutates only parts-to-skip's index reuse and the once path's install. Both
`c4_7b_tests.rs` witnesses fail under it (`validate.sh mutation`).
