# Exact identity UV preservation handoff

Frozen source: `f39ca76a5bde30c47d0dd9ef374f37f930bb9186`; incremental base: `83d15fa4971f4dcbc69aef7890673ff27a560bf0`. SDK c9c5979f04cea8c38213004d4f04df0dcfb40d05. Five changed files only; producer integration is the separate three-line affine.cpp patch. Do not overlay local older parent modules.

## Actual cause and evidence boundary

Original immutable log `/home/louistrue/build-workers/worker-state/jobs/cf149f9a-2efe-4e77-8888-f856b36c3d09/output.log:54324–54344` proves the represented generic curve starts at y=2^-51 while its topology vertex is y=0. Exact endpoint identity is false. The unchanged standalone source rectangle predicate must refuse. Direct Clip is analytic6; its real identity-affine output is generic6. Their 312-value FNV fingerprints match, which alone does not prove byte identity.

Pinned SDK primary sources: SmBSplineCurve.cpp196–234 deep-copies existing materialized NURBS with knot fixup; SmLine.cpp257–266 delegates to it. SmBrep.cpp32782–32973 TurnToNURBS converts by copying existing rational data; SmEdge.cpp2480–2515 SetCurve clears genuine cached UVs on replacement. Thus conversion can lose existing UV authority even while copying an already materialized line. SmLine.cpp1631–1686 generates line controls from STEP endpoint evaluations; that is a possible earlier floating construction seam. Current log lacks canonical input scalar fields and pre-copy scalar dump, so it does not prove the first producer of this value. No invented cancellation is claimed.

## Bounded private authority

`IdentityUvTransfer` runs on the unpublished checked owned copy only, for raw identity, all-planar/linear sources with a real exact represented endpoint gap. It first requires real existing analytic UV admission. It proves analytic plane and line maps equal their actual unit degree1 rational data by exact source-owned dyadic equations and actual parameter dispatch. Signed coordinate axes, clamped supports and genuine complete UV control hulls inside support are mandatory. It checks original trim ownership and rejects DropCurveFail metadata rather than silently discarding it.

It moves original UV objects through the SDK's documented detach-without-delete setter (SmEdgeuse.cpp4473–4610) and dimension2 owner operation (SmCurve.cpp718–735). No point/curve/control/knot is snapped or fitted. After unchanged TurnToNURBS and both original transforms, exact words authenticate complete bounded topology/material-side state, tolerances, vertices, parameters, face domains and actual rational coefficients/knots against the same owned lifetime. Original trim signatures must also match. Then those same objects are reattached once to the same use/mate pairs and actual existing generic method2 admission is required. No caller credential, pointer cache, persistent ancestry record, public opcode, wire field or parser is added.

At most16faces,64edges/vertices/trims,128regions,2048topology objects,32768words/signature, cumulative1000000control reads. Source-derived method8/record predicates and the existing operation ledger/tolerance expansion remain unchanged. The genuine old UV domain supplies authority; it is never inferred from metadata or coefficient bounds alone. Generic EvaluatePoint clamp is not assumed (SmBSplineSurfaceNLib.cpp8683–8747).

If any canonical map differs exactly from rational coefficients, transfer refuses with scalar diagnostics: this candidate does not authorize approximate conversion. The observed tiny endpoint gap remains. Existing affine taint behavior governs owned-stage failure. The borrowed original source is untouched.

## Tests and review seam

Native source tests require byte identity of actual source coefficients/knots/intervals, six real generic output faces with real retained UVs, method2/v1, the still-failing independent exact endpoint proof, then actual Clip success and unchanged6→3 volume assertions. A separate genuine dyadic primitive→actual identity-affine→Clip must still yield six method8/v2 records with the original protocol, mesh, containment and lifetime assertions. A materialized-control/canonical-map mismatch must refuse before any detach. All prior explicit/survey/reflection generic positives, source ledgers and negative guards remain.

Parent producer integration: apply `producer-only.patch` as a hunk alongside the new header; do not copy an older affine.cpp over parent source. No plane.cpp/copy/context/extraction/protocol/CMake/Rust/JS/upstream changes are included. Parent mesh negative-zero repair remains separate.

Syntax-only compilation of affine.cpp and both changed native test TUs passed with pinned SDK includes. All new actual SDK/native/WASM/Rust/browser execution is UNRUN. Prior real Rust plane_clip.rs:48 positive stays required/red until assembled parent execution passes. This is a source candidate, not a whole-affine or production-closure claim. Exact remains permanent/default; paired partitions/layers and appearance remain separate holds.
