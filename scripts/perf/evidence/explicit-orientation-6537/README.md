# Known-explicit orientation prototype (#6537)

**Verdict: qualified default-worker SDK produced-CPU comparison with scoped
ISSUE129 improvement; other SDK families and native phase changes are mixed.**
Both compare immutable BASE `187a72e3302447fc49f2264111501223238a24a7` with CAND
`672f1e09c06ce777507244d2f2c4403d7b38c098`. No universal, isolated-dispatch,
instruction, physical-memory or full-viewer benefit is claimed. Original
correctness bytes remain unchanged; later receipts do not requalify a docs head.

## Source and correctness

Literal baseline: `187a72e3302447fc49f2264111501223238a24a7`. The candidate was
uncommitted when these correctness receipts were recorded; its eight source files
are pinned individually in `correctness-v2/final-source-manifest.json` and retained
under `final-source/`. An eventual commit must contain those exact source bytes.
This is not a complete compiler/dependency closure or a fresh WASM/build receipt.

The private `orient3d_explicit` helper calls the same
`geometry_predicates::orient3d` adaptive implementation and `Sign::from_f64`.
The general dispatcher's explicit arm shares it. Nine known-explicit calls change:
five ray-parity tests, one coincident-surface classification and three
triangle-plane tests. The determinism manifest keeps its explicit and mixed
dispatcher calls. LPI/TPI and interval/fixed/rational fallbacks are untouched.

The new independent rational oracle covers all 24 argument permutations of nine
finite adversarial configurations, including coplanar, collinear, near-plane,
small-coordinate and georeferenced cases. Source comparison verifies all 553
existing predicate-test body lines survive the sibling extraction after dedenting.
The module context remains `predicates::tests`. Production predicates shrink to
156 lines; the obsolete 700-line allowance is removed and only the geometry
allowlist digest changes. The triangle-intersection tests import the canonical
mixed predicate directly instead of depending on a production-only import.

Root's final guarded correctness run reports **4,434 passed, 39 ignored, zero
failures across 283 test reports**. Strict workspace/all-target Clippy passes.
Commands and environment remain verbatim in the archived JSON/logs: debug info
and incremental compilation were disabled for these correctness checks. The
permutation oracle, module-size ratchet and geometry digest assertions ran.
Ignored tests remain ignored; no real-model/browser qualification is inferred.

## Earlier failures stay failures

`correctness-v1/` retains the original disk-reserve abort, the owned cache cleanup
receipt, and the subsequent E0425 compile failure caused by the triangle tests'
missing mixed-predicate import. They are not assertion failures or performance
results. `correctness-v2/` preserves the structural correction, final raw logs,
successful receipts and summary's documented test-name lookup correction.

Historical `07` native profiling motivates investigation only. Its Rust/config
closure differs from this baseline. The orientation attribution includes adaptive
predicate arithmetic and cannot quantify removable enum dispatch. Historical
binaries, source qualification and measurements are not reused as baseline `187`.

## Reproduction and proposed qualification

`correctness.tar.gz` contains all original V1/V2 files, all eight final source
files, baseline predicate source and the independent source-comparison note.
`member-manifest.json` pins every byte count/SHA-256; `artifact-index.json` pins the
container and manifest. The gzip mtime is zero. All 26 regular, safe relative
members were decompressed and compared byte-for-byte with their originals.
No fixtures, tool binaries, WASM payloads, dependency trees or secrets are added.
Original `/tmp` packets were not modified.

For data-only extraction into a new destination:

```sh
python3 scripts/perf/evidence/explicit-orientation-6537/extract.py /tmp/explicit-orientation-replay
```

The extractor verifies hashes/member names before writing and invokes no build,
test, browser or model. The archived patch plus sibling test file reproduce the
eight-file source change on the literal baseline. Dependencies/toolchains and
fresh correctness execution remain necessary; archived exits are historical facts.

After immutable-source review, propose a native successor of qualified controller
`c32830300ebbfe919a9d69df94197dc2ae8cceb0`, changing only its fixed baseline/candidate
literals: two Haus A/A controls and five alternating A/B pairs per Haus, ISSUE129
and Holter. Keep all five iteration totals/walls/FNVs, canonical best-total phase
selection, resource/process/compiler/noise gates and first-refusal cleanup.
Native FNV excludes UVs, textures, material definitions, text metadata and instancing.

Separately propose generic SDK controller
`4d47506a23e304ed4b772f7890e27e37843e8914` against fresh baseline/candidate source
builds: the unchanged four-family 56-process cohort, actual default pool,
post-timer produced CPU-channel identity, untouched diagnostic census and all
existing admissions/freezes/refusals. This SDK boundary does not establish GPU,
metadata, pixel or full-viewer identity. At initial capture, both cohorts were prospective; completed qualifications follow below.


## Completed consumer comparisons

SDK [37167109427](https://github.com/LTplus-AG/ifc-lite/actions/runs/37167109427)
qualifies all 56 samples/28 pairs under the unchanged default two-worker protocol.
ISSUE129 improves in all five observed A/B pairs; Haus, Holter and O-S1 are mixed.
Produced flat/instanced CPU identities and full unnormalized diagnostics agree.
Native [37182263516](https://github.com/LTplus-AG/ifc-lite/actions/runs/37182263516)
qualifies 17 pairs/34 processes with controller `200a7eed8eb3170225a5e7c5d78eb135f1bddf6a`.
The explicit compile-once/held-FD protocol preserves canonical best-total phase
selection; original arm probes qualify separately. Native changes are small and
mixed. All counts/ordered mesh FNVs and selected diagnostic fields agree within
family. Native CSG has 41 failures/6 degenerate drops; SDK has 44 failures, so
cross-protocol fidelity is not inferred. FNV excludes appearance/text/UV/material/
texture/instances. Recorded RSS is sampled, not a physical peak; native available-
memory numerical readings are absent, though the frozen gate ran. No whole-machine
or complete IFC fidelity claim is made.

Earlier correctness failures, compiler-query refusals and controller-summary
refusal remain immutable. [Existing evidence child #6792](https://github.com/LTplus-AG/ifc-lite/pull/6792)
retains complete SDK/first-refusal receipts and the companion native packet.
[Summary-controller evidence #6798](https://github.com/LTplus-AG/ifc-lite/pull/6798)
retains the prior canonical-stderr refusal. These are distinct sources and stages;
no failed run is relabelled, and no unchanged comparison is rerun.
