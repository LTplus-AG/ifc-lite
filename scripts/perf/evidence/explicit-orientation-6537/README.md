# Known-explicit orientation prototype (#6537)

**Performance verdict: qualified SDK comparison, scoped ISSUE129 improvement;
other three families mixed; native unqualified.** Known-explicit coordinates reach
the same adaptive predicate; determinant, sign conversion, degeneracy policy and
geometry contract are unchanged. No universal, isolated-dispatch, instruction,
memory or full-viewer benefit is claimed. Original source-only correctness evidence
remains unchanged; the separate durable cohort below records the measured result.

## Source and correctness

Literal baseline: `187a72e3302447fc49f2264111501223238a24a7`. The candidate was
uncommitted when the correctness receipts were recorded; immutable candidate
`672f1e09c06ce777507244d2f2c4403d7b38c098` contains those eight exact source files,
pinned in `correctness-v2/final-source-manifest.json` and retained under
`final-source/`. Subsequent evidence edits preserve those Rust source bytes.
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

## Original correctness reproduction and historical qualification plan

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
metadata, pixel or full-viewer identity. These were source-only proposals at the
correctness freeze; the separate actual runs below do not rewrite that archive.


## Completed SDK cohort and first native refusal

SDK [37167109427](https://github.com/LTplus-AG/ifc-lite/actions/runs/37167109427),
attempt1, succeeds under unchanged controller
`4d47506a23e304ed4b772f7890e27e37843e8914`, literal baseline `187a72e3302447fc49f2264111501223238a24a7`
and candidate `672f1e09c06ce777507244d2f2c4403d7b38c098`. Both arms genuinely build
fresh SDK/WASM serially before endpoint bundling and measurement. All56 samples/
28 pairs remain: two A/A controls then five alternating A/B pairs per fixed family.
All eight A/A controls pass; largest absolute difference9.115330%. Default pool
is two workers IDs0/1 on four cores, Chrome154.0.8037.57, SAB/COI, no overrides.

Cold processor.init, canonical processParallel drain, retention and dispose are
timed; hashing follows the timer. All flat/instanced produced CPU identities and
complete unnormalized diagnostics agree for all14 samples within each family.
Known semantic approximations/omissions remain in raw diagnostics: identity does
not establish faithful IFC or authored text/UV/texture/full-viewer appearance.
Raw geometry arrays were not uploaded; their SHA witnesses cannot independently
be regenerated from this packet without a new model run.

Candidate-minus-baseline elapsed deltas; negative is less elapsed. The paired
median is the median of five individual ratios, not a ratio of arm medians.

| Family | All five paired deltas (%) | Paired median (%) | Paired range (%) | BASE AB median/range (ms) | CAND AB median/range (ms) |
| --- | --- | --- | --- | --- | --- |
| house | +2.352, -0.670, +2.462, -2.076, -4.093 | -0.670 | [-4.093, +2.462] | 536.030 / [529.800, 546.980] | 530.090 / [518.800, 560.445] |
| csg | -3.111, -1.324, -2.019, -3.305, -1.860 | -2.019 | [-3.305, -1.324] | 4365.170 / [4323.320, 4382.540] | 4237.700 / [4232.650, 4302.310] |
| heavy-csg | +0.306, +0.360, -1.649, -2.054, +0.059 | +0.059 | [-2.054, +0.360] | 5328.775 / [5269.815, 5360.080] | 5285.940 / [5219.305, 5379.385] |
| architecture | -1.163, -1.251, +1.818, -0.590, +2.152 | -0.590 | [-1.251, +2.152] | 4199.185 / [4125.815, 4251.635] | 4200.840 / [4161.725, 4235.755] |

ISSUE129 is faster in all five pairs; Haus, Holter and O-S1 are mixed. No sample
is removed, substituted, pooled or normalized. No significance, physical outlier
cause or removed-dispatch cost is inferred. Both arms already contain merged init
sharing and capture one WASM request/response/finished each; this is no new
acquisition mechanism. Served bytes are qualified through observed requests plus
finite refetches from the same SHA-frozen origin, not CDP loaded-worker body capture.

Independent SDK audit passes1508 retained-receipt/asset checks and59466 immutable
Git/declared-closure checks; root's separate raw audit passes562 checks. Actual24
protocol controls and explicit client typecheck pass. All168 CPU intervals are
at least1000091521ns and at most2.005013% busy. Initial available memory15520415744B,
minimum sampled live availability12734840832B, maximum sampled owned RSS3745370112B;
RSS is no physical peak. Cleanup598 witnesses/0remaining/0zombies; both servers
close with0sockets/faults and final source/asset/tool verification completes.

Fresh emitted WASM SHA-256s are BASE
`dfec532eaf3bc9f94a4456bf974b9c9a21af00da89e0323f2b59f96ce1915a3f`, CAND
`141207f3d0a509cca602537b9857fdb8d9e2c64744f3206d7685e3939a1d796a`.
Both actual assets, section records and indexed body hashes remain. Source changes
intentionally, Cargo/config agrees, and separate build paths may also affect bytes.
Body counts/indices differ; a positional hash mismatch is no semantic-function or
instruction-cost attribution. Remote installed tools/sysroot/registry and final
filesystem checks remain producing receipts, with their declared closure limits.

Native [37167463547](https://github.com/LTplus-AG/ifc-lite/actions/runs/37167463547),
attempt1, uses pin-only successor `9baab5249df8dbce2ae3f461ef9a95ba5d726f7e`.
Both fresh locked probes and24 protocol controls/startup control pass, then first
Haus A/A BASE slot refuses actual `rustc -vV` outside the unchanged Cargo exception.
It is killed before stdout/stderr output; zero samples/pairs complete. Preflight
CPU passes, sample cleanup/log flush and final freeze complete. This is a preserved
process-policy refusal, not arithmetic/geometry defect evidence or a partial native
win. No retry or exemption is applied.

## Durable data-only reconstruction and replay

The original correctness container/index/manifest/extractor are byte-identical.
The separate `sdk-and-native-refusal.tar.gz` retains both original official ZIPs,
all run/job/API/dispatch receipts, independent audits, controller sources and root's
byte-exact raw review. All250 SDK and26 native uploaded members are explicit
verified ZIP-member references, avoiding duplicated payloads. `cohort-manifest.json`
pins every logical byte count/hash, storage and original path; `cohort-index.json`
pins the deterministic gzip-mtime-zero container and original source archive.
Packaging verified every TAR member and every referenced ZIP member byte-for-byte;
no archived program, asset, build, model or browser was executed. Fixture files and secrets
are excluded; actual producing WASM/assets are included as inert evidence.

The reviewed helpers have now passed one bounded data-only guardian run: all525
members reconstruct, replay passes243468 data/Git checks (not geometry test cases),
and nine real reader controls pass: one valid ZIP and eight expected refusals for
unsafe TAR/ZIP paths, symlink/duplicate TAR entries, checksum mismatch, encrypted/
oversized ZIP metadata and unlisted ZIP members. `cohort-validation.json` retains
the complete raw command/output/guardian/fixture data and runtime-only helper delta.
Root independently compares all525 bytes to original filesystem/literal Git origins;
its lossless `cohort-root-roundtrip-v2.json.gz` also verifies source8/evidence4.
The first root checker misread Git-origin metadata as a filesystem path; its raw
failure remains in the separate validation receipt, not relabelled as a model failure.
Main archive/manifest and original correctness archive remain unchanged.
These commands reproduce bounded data-only verification:
bounded safe regular paths, types, unique names, manifest census and hashes, then
recompute schedule, A/A, raw complete/identity/diagnostics, CPU/resource/cleanup,
all five deltas, native zero-output refusal and immutable Git source hashes:

```sh
python3 scripts/perf/evidence/explicit-orientation-6537/cohort_archive.py /tmp/explicit-orientation-cohort-replay
python3 scripts/perf/evidence/explicit-orientation-6537/replay-cohort.py --repo /path/to/ifc-lite
```

The replay uses the repository-reviewed helper, JSON, bytes and bounded Git-object
reads. Archived scripts/JS/WASM remain inert. It does not recreate the terminated
runner, rehash unavailable tools, regenerate meshes, install, compile or benchmark.
Exact four controller/subject Git commits must be available locally. Prior raw
packets and the original source archive remain unmodified. Required CI/review and
any further native qualification remain separate; this packet asserts no readiness.
