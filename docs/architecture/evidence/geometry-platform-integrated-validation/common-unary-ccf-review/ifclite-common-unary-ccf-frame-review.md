# Common unary raw-source/frame/math review

Frozen child `ccf483375bdcc42c3264e4d0ed1efea8f693a41f` against `775567f2bd1360fdf239fe96818cf7b1d3184c4c`. Read-only source review; no source edits, builds, tests, executable probes or jobs. Later PlacedClip dependency commit0b76565c4c and parent499cc reply-box /8828 walk changes are outside this child delta and must be composed independently. Native SDK/browser execution remains unqualified.

## P1 — Difference selects the opposite side from the existing exact policy

`processing/src/element/session_retained/issuance.rs99–101` maps Agreement true to runtime PlaneSide::Positive for both modes, then selects runtime Difference. The adapter/runtime Difference keeps the complement of the selected side. But the existing exact Difference plane path keeps the agreement-selected side itself: `HalfSpacePlan::clip`57–63 uses +normal for Agreement true, `boolean/work.rs::Plane::evaluate` calls that unchanged clip, and `csg/mod.rs453–459` keeps AllFront and discards AllBehind. `csg/plane_eps.rs274+` identifies front by positive signed distance. The independent pre-existing cap orientation oracle explicitly documents +z keeping the top half for Agreement true (`halfspace_cap_tests.rs240–244`). There is no intervening sign inversion in the exact plane continuation.

Concrete differentiator using the new fixture's actual host: area8, local z0..3, plane z1, +Z and Agreement true. Existing exact Difference keeps z>=1 (volume16); candidate runtime Difference removes z>=1 and returns z<=1 (volume8). For Agreement false these outcomes reverse. This affects both native and browser because they share clip_parameters, and intact receipt validation currently authenticates that same wrong issuance rather than detecting it.

The new positive tests cut exactly at z1.5 and assert only absolute volume12. Both complementary pieces have volume12, so all four side/mode loops can pass while Difference orientation is inverted. The new Difference Empty fixture at z=-10 is also reversed relative to the exact baseline: exact keeps the whole host, while candidate produces Empty and holds it Unsupported. At z=+10 the converse is more serious: exact produces true Empty (noncoincident with host), while candidate keeps the whole host and could accept it as nonempty.

Minimal preservation repair: retain original source Agreement and normal, but derive the runtime side separately for the operator. For legacy Difference, true must select Negative and false Positive because runtime Difference subtracts that selected side; retain runtime PlaneClipMode::Difference so its wire and receipt mode stay honest. Intersection's independently chosen halfspace policy should be explicit and tested; the old exact operand path does not provide the same plain-halfspace Intersection implementation, so do not claim its behavior is proven by the Difference baseline. Acceptance should reuse the corrected single helper, as it already does.

Required regression: use an off-centre plane (z1) and assert both local signed bounds and unequal volumes against the existing actual exact result for .T./.F. Difference. Native and actual Worker receipts should assert side/mode as well. Add both far planes to distinguish deliberate full removal from full preservation, and update the Empty hold witness to the side the legacy clip actually empties. Preserve the authenticated Difference-to-Empty hold until the full-host-removal compatibility policy is truly discharged. Do not change exact HalfSpacePlan semantics or relax its oracle to match the new implementation.

This is source-derived correctness evidence, not an executed reproduction. My earlier preliminary message saying the signs agreed was incorrect; tracing the actual exact AllFront branch established the inversion.

## Raw capture and factored exact lowering

The shared helper factoring preserves the old exact lower order: resolve BaseSurface, read Agreement/default true, require Plane, resolve Position, parse placement and normalize columnZ. No exact HalfSpacePlan::clip/capping/removal heuristic is changed. Source helper returns the same resolved position rather than reloading another source.

retained_clip.rs captures IDs for Boolean/halfspace/base plane/position and each explicit coordinate/direction leaf, arity2/3 and original finite f64 values, optional omitted axes, authored/effective Agreement, units, epoch/revision and unique occurrence before from_position runs normalization. Raw direction magnitudes and optional RefDirection are retained; the normalized source plane is separate from original coefficients. It accepts only plain HalfSpaceSolid and refuses bounded polygon/Union before following their extra boundaries. The additional typed finite raw-leaf restrictions apply to this explicit retained candidate, not the exact helper.

## Frame transformation

The derived formula at retained_clip.rs90–98 is correct for the stated domain: F maps selected actual object-local metres into the enclosing representation's metre frame, q=s*p_source, p_local=F^-1*q, and n_local=F_linear^T*n_source. Indeed n_source·(F*x-q)=n_local·(x-p_local). Uniform positive unit conversion changes the plane point and drops out of the normal's homogeneous scale. No RTC/viewer axis transform is mixed into those coefficients, and the selected proper-rigid frame is retained unchanged in the unary value/receipt.

Mapped nonrigid/reflected frames are physically baked by the existing mapping Ready admission before this source step; bake resets object_frame to identity. Proper-rigid maps retain their explicit frame. Thus this helper does not misuse inverse-transpose on a still-unbaked nonrigid frame or claim a nonrigid BrowserDependency is rigid. Original source/map/unit history remains in logical placements and sealed runtime lineage. Captured raw source stays separate from numerical coefficients.

The present new source witness uses mm units, survey translation and an axial nonunit normal, which is meaningful but cannot distinguish transpose/inverse mistakes for a rotated frame. Before broader frame qualification, add actual non-axis rotation/oblique normal and nonuniform/reflected baked-host witnesses with independent signed-side/bounds expectations. This is a qualification coverage requirement, not a second demonstrated math defect.

## Original continuation and ownership

The retained Boolean branch still tests semantic Empty host before resolving the later operand. A reached plain halfspace now produces one operation on the same ReadyBoolean/RetainedStep continuation; it does not restart traversal or manufacture an authored construction. Clip output copies host placements/presentation and replaces its definition/slot with an operation identity. Real semantic outcome binds that output slot in the original held common reply, with one-outcome-per-original-step enforcement.

Processing captures the original request/ticket/source context/stage and ordered input Arc, validates logical ledger identity and actual live domain, checks input/output/plane/side/mode/frame, then consumes the original reply. Native and browser use the same dependency selection and clip_parameters; raw source metadata is held in the expected operation, not submitted as an SDK success assertion. Difference Empty validation deliberately holds work and pending reply intact before outcome mutation/linear take, because the SDK finite-domain bound cannot prove the old host-mesh AABB-corner coincidence policy. That hold is honest residual coverage; it does not close intentional full removal or coincident-host compatibility.

No giant cutter mesh, fake source recipe, new SDK runtime edit, alternate control walker, cap raise, exact fallback or final-net publication was introduced in this delta. Union, polygon boundaries, paired splitting/layers, openings and final appearance/coverage remain open. The parent reply-box/walk fixes and existing cleanup repairs must survive incremental integration.

## Pins and execution boundary

Exact24 inspected file Git/SHA256 pins are in `/tmp/ifclite-common-unary-ccf-frame-review-hashes.json`. Existing oracle fixture tests and new real-source/native/actual-Worker test sources are registered but unexecuted here. The current SDK failure cannot be treated as successful common unary qualification, and source math review cannot replace either target run.
