# PR #7914 takeover: browser boundary evidence

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
No overall root-test or full-workspace pass is claimed by this packet.

Private browser publication `pop-os-bf7d2a91-7914-browser-selected` was verified
with manifest SHA256 `4ce58e8d8db0fc4b09e92f5dd68c533cf86432356ddcc71aa69f85330fd33931`.
The stopped service job is `a965417b-697c-4394-8b62-2e8363c91a3c`. Storage closure
was deferred when the guard refused it because another benchmark was queued or
active; no lock or ownership was overridden.

**PR acceptance remains held.** Prior measured regressions, upstream acceptance,
full exact-source qualification and required checks remain separate barriers.
