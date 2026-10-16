# MiniBIM functional proof — source 1cb4; reviewed-data update

This records actual execution at `1cb4bd2119e36261322227249b2f89bc03194f04`,
with selected main `d03448ac4b0a64722446288d0e2bfd798cfda947`.
It is a functional proof pack, not a merge-readiness or performance verdict.
The layers are [#7024](https://github.com/LTplus-AG/ifc-lite/pull/7024),
[#7643](https://github.com/LTplus-AG/ifc-lite/pull/7643),
[#7638](https://github.com/LTplus-AG/ifc-lite/pull/7638),
[#7640](https://github.com/LTplus-AG/ifc-lite/pull/7640), and
[#7639](https://github.com/LTplus-AG/ifc-lite/pull/7639).

## Actual result and limits

- Native and Node WASM match in all 27 contexts: nine authored target solids,
  each with no, one actual, and all actual opening relationships. The lower
  opening layer repairs eight with closed Watertight source. Uncut raw
  IndexOnly closure is not universal: 150890 retains its baseline 12 unmatched
  edges in that source policy.
  Positions, normals, indices, origins, colors, bounds, transforms and captured
  IDs/types match exactly. Native emitted order and multiplicity are retained.
- Direct checks of those saved arrays pass strict directed closure and zero
  collapsed triangles in stored and origin-restored grids. All 18 retained
  area/volume comparisons use the existing Rust test formulas, without larger
  allowances; winding is outward. The selected prepass frame is measured here;
  the four-frame fixture suite is separate evidence.
- Actual T3 File input, fresh storage, four geometry workers and one healthy
  WebGPU device produce all nine target slabs matching Node's all-opening
  positions/normals/indices, IDs, counts and origin bits. JSON-only origins are
  finite and nonzero; a future zero-origin case needs a raw-bit receipt.
- The original v3 collector separately records every own geometry-result field
  and complete resident CPU geometry: 2,178 flat meshes, 68 instance templates,
  694 instance entities and 1,768 occurrences. Its Merkle root is rechecked.
  This is not full-scene native parity, GPU-buffer/pixel identity, or a proof
  that every model element is correct. The browser log retains two CSG failures
  across two products. This is the actual current receipt
  `receipts/browser-needle-1cb4-receipts-v1/functional-minibim-needle-1cb4-v1.result.json`
  model-wide warning; this pack does not diagnose those failures. Native
  finish/texture fields are outside the flat parity contract.
- Mesh/collection and prepass/API cleanup paths are retained in the harness.
  No allocator-leak or memory-performance result is claimed.

The fixture SHA256 is
`7d3ae097a2f1ca5e63f7698d12215cb58427cdb6a932e75e6bf1ca222bcf873b`;
the actual candidate WASM SHA256 is
`abaecd85bbc2d65b67454c79b496c6e903fd51b5d7c5db301146891a6682cf39`.
Successful source-built candidate and paired selected-main build receipts
identify the exact sources, commands, toolchains and served geometry WASM.
No historical 11a payload or browser result is substituted.

## Reviewable evidence

[Full model](screenshots/full-model.png) ·
[Actual isolated slab135923](screenshots/slab-135923.png).
Both PNGs are unedited actual T3 screenshots; their source paths, bytes and
SHA256s are in [manifest.json](manifest.json). Screenshots supplement numeric
proofs and do not establish topology or benchmark performance.

[execution-evidence.tar.gz](execution-evidence.tar.gz) contains only receipts,
logs, saved payloads/wires and execution/replay harnesses. The manifest maps
EVERY original path to its byte-identical archive/copy path and SHA256.
It also records archive hash, member count and deterministic repeat validation.
Tar entries are sorted with fixed ownership/modes/timestamps; gzip has no
filename or current timestamp. No IFC/model file, generated runtime binding,
WASM binary, native ELF, node_modules or production source change is archived.
The only archived Rust code is the temporary evidence adapter. An initial
verifier authoring error and its source are retained explicitly: it expected a
duplicate manifest field absent from the real serving-state schema. The
corrected successful checker verifies actual side/epoch and source/build data.

## Replay and remaining holds

Extract the archive and obtain the pinned repository source and authentic
fixture separately. Build fresh WASM/viewer and native artifacts, then use the
archived parameterized prepare/run/compare/shape/browser-check harnesses with
explicit fresh paths and NEW outputs. Inspect each script's help and retained
command/intent receipts. Browser replay requires a real T3 session and the
actual canonical File input; it is not performed by an offline checker.
Absolute paths and original binary hashes document the original execution.
A fresh build/run must generate new source/runtime/wire/binary receipts; it
must not be forced to match the old native ELF hash or relabeled as that run.
Offline receipt/Merkle consistency alone does not prove a new build or load.

The later reviewed expected-data stack ends at
`58a01227c7ccf20cc0ac701a6afd5a70e40e7848`. It preserves production bytes
from the actual 1cb4 runtime; no execution is relabeled as 58a012. The complete
census migration changes exactly 3 of 1640 rows, with 1637 unchanged. Independent
bounded reviews now approve 13797's needle-repair row; its primary open edges
still increase 72→104 and strict edges 132→134 despite removal of collapsed
faces. Exact projected multiplicity by authored depth and complete finite-face
bounds support that bounded decision, not exact 3D identity, watertightness,
material bijection, or resolution of the inherited interior-sheet discrepancy.
The separate 13797 evidence archive retains the full analysis and both reviews.
Original ordinary-census/native identity FAILs remain recorded. Fresh pushed-head
ordinary/required CI and review, and current-base end-to-end worker-pool
performance remain separate merge requirements. No predicate, tolerance,
acceptance ceiling, admission or noise gate is relaxed. All v3 timing code
remains unchanged and no timing cohort was launched. V1 remains an immutable
record of its earlier creation status; V2 updates only this text and metadata.
