<!-- SPDX-License-Identifier: MPL-2.0 -->
# Initial outward cutter construction: scoped candidate

Candidate patch: `/tmp/ifclite-plane-outward-construction.patch`, SHA256 `37918b28a0ccd16aeac1d3ca7162b354d05a17c324e5e61e5a1a2aa6b10ffa93`. Two paths only: `native/smlib-adapter/src/plane.cpp` and `tests/plane_tests.cpp`. This reviewer did not edit either root file, compile/link, run tests/SDK, or submit a job. Apply-check passed against the current root. This candidate has no numerical qualification.

## Actual failure and primary mechanism

Parent's new actual diagnostic establishes raw N=(1,1,1), constructed Y=(0.81649658092772615,-0.40824829046386307,-0.40824829046386307), and effective post-stitch X=(0.81649658092772603,-0.40824829046386302,-0.40824829046386307). Exact dyadic N·effectiveX=-2^-54, nonzero. Thus an epsilon, sampled-plane, volume or normal-alignment acceptance would falsely accept a changed plane. The candidate does none of those things.

The deeper cause is pinned source, not an assumption about ordinary rounding in SetCanonical alone:

1. `SmBrep.cpp:26661–26726`: StitchAndOrient stitches then calls OrientTrimmedSurfaces.
2. `SmBrep.cpp:24615–24637`: orientation repair calls Face::SwapUV for reverse faces.
3. `SmFace.cpp:13928`: Face::SwapUV calls surface SwapUV, replacing matching UV trims and faceuse orientation consistently.
4. `SmBSplineSurface.cpp:5191–5237`: SwapUV calls ToggleSwapUVBit then SetCanonical of the transposed rational surface.
5. **SmBSplineSurface.cpp:4560–4601**: SetCanonical calls virtual `RebuildSTEPFromNURBParameters()` after swapping its NURBS. This path is additional to the analytic axes exchange in ToggleSwapUVBit.
6. **SmPlane.cpp:4279–4327**: RebuildSTEPFromNURBParameters evaluates three rational surface corners, subtracts/normalizes their rounded positions, derives new UV scales and origin, and calls SetCanonical. It changes the analytic supporting plane when those rounded corner operations introduce non-proportional component errors. This matches the observed changed axes and UVscale=(1,1.0000000000000002).

## Construction change and geometric proof

Let the existing positive-determinant clipping-volume frame be X,Y,Z with Z=X×Y; coordinate extents U=[u0,u1], V=[v0,v1], W=[0,w1]. The target retained side is +W. The six outward normals must be:

| Face | Old axes | Old normal | New axes | New interval in changed coordinate | Desired normal |
|---|---|---|---|---|---|
| base W=0 | X,Y | +Z (inward) | X,-Y | V'=[-v1,-v0] | -Z |
| back W=w1 | X,Y | +Z | unchanged | unchanged | +Z |
| left U=u0 | Y,Z | +X (inward) | Y,-Z | W'=[-w1,0] | -X |
| right U=u1 | Y,Z | +X | unchanged | unchanged | +X |
| front V=v0 | X,Z | -Y | unchanged | unchanged | -Y |
| rear V=v1 | X,Z | -Y (inward) | X,-Z | W'=[-w1,0] | +Y |

These normals have the stated signs for a right-handed frame. Sign changes are exact binary64 negations. For the base, the map P+uX+vY becomes P+uX+(-v)(-Y), with exactly the same original origin and rectangle; left/rear use the identical sign-cancellation identity. No plane point, clearance, extent, or side/mode is moved. Axis order stays the same, so no extra in-plane axis selection/renormalization is introduced by this change.

The actual creation route supports choosing orientation this way: `SmBrep::CreateFaceInRegionFromSurface` at4236 gets the natural trim loop through `CreateNaturalUVTrimCurves(...,SM_SP_U,FALSE,...)` and the live old-algorithm path at~4348 calls `MakeFaceWithCurves(...,SM_OT_SAME,...)`. Thus the new analytic parameter normal is initially the upward faceuse normal. Constructing all six normals outward removes the *need* for a later base UV swap to produce the intended material solid.

This is not a claim that SDK orientation can never choose a swap under its tolerances. The candidate leaves StitchAndOrient, all full actual geometry validators and the exact post-stitch assertion in place. Unexpected reconstruction still rejects and retires the tainted domain. There is no after-stitch analytic patch, restoration or overwrite.

## Exact post-stitch guard

Because the intended base is now created with axes (X,-Y), the exact assertion compares the actual axes against **that intended pair** or their exchanged order, rather than the old inward pair (X,Y). Origin equality remains exact. This is not an epsilon relaxation or a new approximate acceptance class: it is the same stored-coefficient identity requirement relative to the new constructor arguments. A changed effective coefficient like the observed one remains rejected. The existing diagnostic is relabelled `volume frame` since it prints the original X/Y/Z volume coordinate frame; raw request and actual plane diagnostics remain.

The preexisting construction frame itself uses normalized binary64 axes, with its existing residual check. This patch does not assert a new theorem that arbitrary raw input normals always admit an exactly equivalent binary64 canonical SDK plane. It specifically removes the observed *additional* analytic reconstruction drift while preserving the current original-frame/actual-plane identity rejection. If broader raw-plane exact-equivalence coverage is required, it remains a separate coefficient-certificate requirement; no such predicate is silently substituted here.

## Preserved invariants and added actual witnesses

All of these are byte-for-byte unchanged: complete six-face identity, pointer status+report validation, manifold, geometric closed loops, positive finite volume, actual interval containment of all five non-cut walls, domain/clearance arithmetic, certificate original plane bytes, ownership, destructive-failure status8 and source immutability.

The existing centre-oblique (1,1,1) C ABI case directly reproduces the failed orientation path. Added off-centre paired-normal cases retain the same clip_case machinery and unchanged oracles. For [0,2]^3 and cut x+y+z=2.5, lower volume is `(2.5^3-3*0.5^3)/6=61/24`, upper is 131/24. Both raw normal signs, both occupied sides and Intersection/Difference are exercised. These distinguish material sides even though symmetric centre cuts each have volume4. Existing shell checks independently assert requested side, outward normals, closed opposite edge incidence and mesh-volume agreement; all tolerances remain unchanged.

No assertions were removed or broadened. The original absent-UV chain still fails admission until separately repaired; this candidate does not create trims or change source-domain eligibility.

## Required qualification

Root should review/apply this narrow candidate and use a distinct source-bound full qualification after the current original job terminates. A pure syntax pass, the algebra above, or an old SDK run is not a numerical verdict. The centre/off-centre, axis, both modes/signs, survey, scale, cylinder, strict copied-host/cutter/output validators and actual Rust/browser consumers must run at the corrected source. Any remaining exact assertion must be diagnosed, not widened.
