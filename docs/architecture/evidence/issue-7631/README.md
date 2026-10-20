# Profile cap boundaries (#7631)

The cap retry repairs a missing-boundary class in MiniBIM slab 135923: an
earcut face is positive in f64 but collapses or reverses in local f32. The
recovery retains authored scalar vertices and constrains unaffected diagonals.
It accepts only a valid bounded ring domain, complete oriented boundaries and
representable output faces. Revit 13797 exercises the reason for retaining
unaffected diagonals: a whole-cap retriangulation changed its opening result.

[qualification.json](./qualification.json) preserves historical execution on
lower base `e80d0925`. The cap patch has been combined with the finite local
jamb repair on `40ea21c2`; that changes production inputs. These native, WASM
and consumer receipts retain their original source identities and do not
qualify the combined source. Combined native execution and runtime remain pending.
The extra scalar derivative test has its own historical execution record.
The engine budget and runtime condition remain separate from build and
correctness results.

The canonical WASM capture runs every actual MiniBIM slab with no openings,
one opening and its complete opening set. Each produced mesh has paired
directed edges and no collapsed triangles at the kernel grid. Every mesh,
collection, pre-pass cache and API handle is released. Canonical RTC-frame
triangle counts differ from the census frame; neither count is substituted
for the other.

The earlier `f21b4861` combined source separately passed the official build, consumer checks
and all 27 canonical WASM cases. Their complete payloads equal the historical
case records; the new source, artifact and receipt identities are recorded in
`combinedQualification`. The original engine-size failure is retained.

The current lower base `99622674` additionally preserves distinct coaxial
opening depths. This changes production inputs again. Qualification of that
source remains pending; earlier receipts retain their recorded source scope.

The committed behavioral regressions are
`rust/processing/tests/issue_6940_profile_cap_boundaries.rs`,
`rust/geometry/tests/triangulation_invariance.rs`,
`rust/geometry/src/profile_cap_tests.rs`,
`rust/geometry/src/profile_cap_predicate_tests.rs` and
`rust/geometry/src/profile_cap_adjoint_tests.rs`. Fetch the catalogued fixtures
with `pnpm fixtures` before reproducing the workspace runs. Regenerate WASM
with `pnpm build:wasm`; root builds and typechecking use `pnpm build` and
`pnpm typecheck`. No geometry output or runtime verdict is inferred from a
build alone.
