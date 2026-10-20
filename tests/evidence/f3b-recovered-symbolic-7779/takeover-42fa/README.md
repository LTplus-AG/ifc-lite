# PR #7914 takeover: qualification and remaining holds

The user authorized session bf7d2a91 to take over the existing held PR. Source
`42fa46cfd093d82b45e0f36427649637a5c0f7af` fixes projected arc extrema,
full-frame vertex/elevation alignment and projected text direction. The source
regressions are exercised by `rust/processing/tests/symbolic_projection_fidelity.rs`
and the existing `issue_2356_trimmed_curve_basis` integration suite: all 18 tests
passed on PC/WSL, with no skips.

The browser loaded the actual JS/WASM from the official `pnpm build:wasm` at
that source and called `IfcAPI.parseSymbolicRepresentations` on parsed STEP
fixtures derived from those regression tests. Each returned primitive handle,
collection and API was freed in `finally`. Assertions examined copied numeric
output, and the canvas draws the returned arc points. This is functional browser
boundary evidence. It does not exercise the canonical viewer load path or prove
GPU rendering/performance: the T3 Chrome 154/Linux runtime disables GPU access.

- [Numeric browser output and four assertions](result.json)
- [Official build identity and asset hashes](browser-build.json)
- [Screenshot of the actual output](verification.png)

The checks establish retained interior arc extent, alignment of five primitive
families under tiny tilt and large local Z, downward elevation, and the analytic
oblique text baseline. They do not assert complete cross-target byte identity.
The ordinary overlay entry point chooses its normal RTC frame; reported
`worldY` values are in that frame.

The first independent fix review identified zero-span compatibility and a weak
text-direction control. Both were corrected. A fresh Fable review at the exact
source above found no source blocker, explicitly bounded to the fixes since
`05ae74bda8`. Its source verdict does not waive performance, full golden/Clippy,
required hosted checks or parent/current-main integration.

The earlier full Rust run at `89621e8cc9` failed the existing zero-span control
before Clippy could execute. That superseded failure remains retained in worker
job `f66f35a0-0444-410c-9a03-753c2d2810a7`; the corrected focused run is job
`90d130d8-74a1-4805-bb6e-939979f83412`. Official WASM build job
`c3673e72-c537-4a44-bfc2-d415f4220721` passed the build and exact committed-type
comparison, then failed before contract tests because renderer `dist/` was
absent. Root-build continuation `94ac70ac-8e8c-4bdc-84f9-025f4a22f079` supplied
the workspace artifacts: real WASM contract results were 212 passed, zero failed,
one skipped historical-fingerprint fallback. Root typechecking also passed.
The full Rust continuation at the same source subsequently passed: 5,417 tests,
zero failures, 46 declared ignored, and strict workspace/all-target Clippy.
All 182 fixtures were fetched. The native export and symbolic goldens passed
without repinning. [Receipt summary](native-qualification.json) retains source,
toolchain and log identities. The [formal revert oracle](formal-oracle-summary.json)
observed nine assertion failures under the declared mutation, with 51 baseline
passes and verified restoration. It covers the original conic behavior; it is
not mutation coverage of every takeover change.

The root TypeScript run reported the stale `#7306 over-256 live
placement walk` assertion as failing. This stack predates its correction on main
in PR #7916 (`9ffcc10e80f75b0645ba622e042961cd23bbc42e`), which replaces the
removed depth-cap expectation with valid-chain and cycle controls. No overall
root-test pass or current-main integration pass is claimed. The owner interrupted
the remaining run after that failure: viewer totals are 12,954 passed, one failed,
588 cancelled and twelve skipped. The worker receipt reports exit zero after
SIGINT; the [log-based result](root-consumers-summary.json) explicitly overrides
any interpretation of that receipt as a green test graph. The original log hash
is retained, including the interrupted final UTF-8 character.

## Real-model output and independent oracle

The measured full symbolic payload changed only two near-zero coordinates on
Duplex, and 606 point components on eleven ISSUE_129 beam Axis curves. No
collection lengths, point-array lengths or metadata changed. The latter are
substantial corrections: the old projection discarded the negative local Z
axis of the authored 3D placement. [Classification](payload-classification.json)
and the four compressed full payloads retain the actual differences.

[IfcOpenShell 0.8.5 placement utilities and authored circle equations](issue129-oracle.json)
independently establish the corrected positions. Registration of the renderer
frame uses 694 unchanged endpoints from 347 other entities; the eleven changed
curves are excluded from registration. The anchor residual is below 7 micrometres,
and all corrected curve errors are below 2 micrometres, against a 0.1 mm tolerance.
Baseline errors range from metres to 18 metres. This is an IFC placement/curve
oracle, not an OpenCascade tessellation or global geodetic certificate.

A fresh browser load of that public fixture through the actual frozen WASM
returned 481 polylines and matched all eleven curves to that independent oracle.
The same session passed the zero-span compatibility control. It verified both
fixture and WASM SHA256 before extraction. [Summary](real-browser-summary.json),
[complete numeric output](real-browser-result.json.gz) and
[screenshot](real-browser.png) retain the result. The GPU-disabled browser caveat
above applies equally here.

## Paired performance: mixed, held

[Source/binary/protocol identities](paired-identity.json),
[lossless raw observations](paired-rows.jsonl.gz), and
[all sample arrays and summaries](paired-summary.json) preserve one exclusively
admitted, balanced AB/BA cohort. Baseline is ordered parent `7cdd67bc3e` plus the
identical probe example (`13832a244b`); branch binaries were freshly compiled
from `dceadbbe57`, whose Rust and test sources equal `42fa46cfd0`.
There were twenty cold-process symbolic pairs per fixture and six native pairs,
with five iterations per native process. Serialization/hashing is outside the
public symbolic extraction timer. Native phase counters retain the probe's
best-iteration convention; wall time is summarized separately.

Native mesh/vertex/triangle counts and ordered mesh hashes match for all three
fixtures. Those hashes do not cover appearance or auxiliary payloads. Complete
symbolic Haus JSON matches; Duplex and ISSUE_129 changes are classified above.
Medians and paired medians differ in direction on some cases. The result is
mixed, with no neutral or overall improvement claim. It neither qualifies the
distinct earlier private integration nor waives its measured regressions or the
parent instruction-budget hold. No benchmark pins or ceilings changed.

Executable provenance preflight rejected a first branch preparation because
Cargo's relocation cache reused the baseline binary. No timings were collected
from that invalid pair. The replacement required non-fresh workspace compilation,
verified embedded source paths and frozen executable hashes before timing.

Private browser publication `pop-os-bf7d2a91-7914-browser-selected` was verified
with manifest SHA256 `4ce58e8d8db0fc4b09e92f5dd68c533cf86432356ddcc71aa69f85330fd33931`.
The stopped service job is `a965417b-697c-4394-8b62-2e8363c91a3c`. Storage closure
was deferred when the guard refused it because another benchmark was queued or
active; no lock or ownership was overridden.

**PR acceptance remains held.** Prior measured regressions, upstream acceptance,
the failing raw-stack TypeScript graph, current-main conflict resolution and
required hosted checks remain barriers. A read-only probe against main
`141285f8287bbc88a420d0ce1168cb7f1a6aa72c` found thirteen inherited conflicts.
This packet changes no production/test source after the qualified `42fa46cfd0`.
