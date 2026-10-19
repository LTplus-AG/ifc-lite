<!-- SPDX-License-Identifier: MPL-2.0 -->
# Fixed generated-plane constructor transaction

This additive correction follows frozen `3cdbd93313a612d95792dfaa11cbd1884de56abc`.
It does not expand ordinary `Phase::InitialConstruction` or grant authority to
an arbitrary mutator, callback, flag, face index or caller-supplied integer.
The existing private-issued object revision and parent runtime sealing
preconditions still apply. Only a generated-interface root is admissible for
this constructor receipt; original source boundary is a different authority.

`GeneratedPlane::create` owns a fresh BRep and fixed calls to
`SmPlane::CreateCanonical`, `AdjustSTEPUVDomain`, `CreateFaceFromSurface` and
`CreateUVTrimCurves(FALSE)`. Every returned status and notification latch is
checked. The phase accepts only its exact newly constructed surface and face,
current frame and incomplete constructor generation (or its single initial ADD
child). The pin's `SmBrep::MakeFaceTopology` temporarily assigns the surface
owner at `SmBrep.cpp:14295`; at most four sectoring detach/restore pairs can
follow for this four-edge patch (`14510/14544`). `MakeFace` then restores the
old owner and installs the final face (`18885/18915`). The constructor call has
an eleven-transition bound. The explicit trim call has a separate exact
two-transition bound: `SmFace::CreateUVTrimCurves` clears the surface owner at
`SmFace.cpp:8035`, restored by `SmRescueSurfaceOwner` at `7936`.
No owner transition is exempt outside these fixed synchronous calls.

Postconditions require the actual one face/four edges/four unique corner
vertices, exact owner links, exact requested frame/domain and unit UV scale.
A bounded retained representation seal covers the supported complete graph
and current face generation. First admission requires the exact issued
incarnation/session/slot/generation/revision/operation, same construction frame,
complete unique face inventory and unchanged representation. The receipt is
consumed by admission. Notification edits still permanently revoke initial
eligibility; snapshots do not restore it. Failure after starting construction
abandons the result and taints the isolation with status8, preserving the
primary error. Allocation cleanup is not claimed.

Supported graph restrictions remain those of
[CLOSED_WORLD_NUMERICAL_CONTRACT.md](CLOSED_WORLD_NUMERICAL_CONTRACT.md): old
tolerance model, bounded unattributed same-context materialized plane/line or
generic B-spline data, complete actual trims/owners/uses and no unknown hooks.
Unknown user/system/attribute hooks refuse authority even on SUCCESS. Exact
retained equality detects a changed boundary representation; it does not prove
absence of hidden/intermediate edits or confer general numerical/domain
correctness. Private phase identity is not a public operation certificate.

Actual SDK witnesses remain UNRUN for this increment. Sixth-lane positive:
fixed construction -> complete generated roots -> checked copy -> release.
Seventh adds generated construction -> extraction -> copy -> release. Sixth
negative controls preserve ordinary/expired/unknown construction, missing or
duplicate inventory, rooted/derived relabelling, surface replacement/trim,
notifying edge/vertex/UV/3D curve edits before and after roots, and add external
surface detach/restore, receipt revision mismatch, source-boundary relabelling,
and silent face-domain mutation before first admission. No op21/cap128 is added.
