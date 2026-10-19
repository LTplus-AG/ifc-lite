# Common unary finite-plane continuation assembly

Implementation-only handoff, 2026-10-19. No compilation, test execution, heavy admission, worker job, push or PR was performed by this implementation session. SDK qualification was reported red by the parent; this handoff does not establish numerical correctness or preservation completion. `final_product_available=false` remains the product contract.

## Immutable sources and integration

Exact implementation base: `775567f2bd1360fdf239fe96818cf7b1d3184c4c`.

Apply these implementation commits in order, retaining each corrective layer for review:

1. `ccf483375b`: original common UnaryClip/source/processing continuation and test source.
2. `4e209fbe0e`: box the immutable issued clip packet and admit its backing.
3. `d15bca2b27`: move Difference Empty compatibility hold after captured resource first-fault checks, before allocation/binding/linear acceptance; add actual SDK-gated cancellation/refusal witnesses.
4. `b53ef01c6b`: oblique rotated-normal and reflected/nonuniform baked-frame source algebra witnesses.
5. `43e06440f5`: correct occupied-side sign, add off-centre/paired-exact/signed-bound/centroid/complement witnesses; generated attribute slots; bit-exact plane identity; refundable Box admission across fallible lineage copy.

The runtime prerequisite is the parent's additive `5468eeba29`: native/browser `Dependency::PlacedClip {clip,world_from_clip}` selects an absolute proper-rigid replacement frame and preserves original Clip identity/frame. This isolated checkout borrowed only that commit, as cherry-pick `0b76565c4c`. Do not reapply it to a root already carrying `5468eeba29`. None of the five implementation commits edits runtime/native/helper/header/kernel files.

The implementation patch is the cumulative exact-base diff restricted to `rust/geometry` and `rust/processing`; the runtime prerequisite is separate. The final chat handoff supplies its external artifact path and digest. `source-files.sha256` pins final implementation files, plus the unchanged committed edge fixture and implementation plan. This manifest intentionally excludes itself and these explanatory documents.

Parent-owned `retained_walk` accounting and processing Box/Reservation corrections are absent from this isolated base. Preserve those root hunks when applying the narrow additive operation branches; do not replace entire root files with this checkout's versions. In particular, inspect the new issuance packet's combined admission with the parent's resource-ownership changes. `session_retained.rs` reaches 400 physical lines in this source; split later additions rather than raising an allowance.

## Contract and file ownership

Geometry owns `program/retained_clip.rs`, the reached Boolean subtype branch and logical UnaryClip variant/output. `HalfSpacePlan::source/from_position` shares existing reference/default/normalization policy with exact `lower`; raw capture precedes normalization. Fixed-width coefficients retain source ids, arity, location/axis/ref-direction values, authored/default AgreementFlag, source occurrence and Boolean/plane/placement ids, units, epoch and revision. Derived output is an Operation, never an authored extrusion recipe.

Processing owns the existing pending transaction, ticket/stage/context/owner, ordered input Arc and target-selected ledger. Target projections expose sealed Clip receipts. Native/browser adapters consume the same issued operation batch. Acceptance validates live original input/output handles, coefficient bits, selected frame, mode and side before the original reply's actual Empty binding and linear acceptance. A shifted or signed-zero-different independently sealed Clip receipt cannot substitute for the issued receipt. No completion buffer or caller-created runtime receipt is introduced.

Raw source plane and effective plane are separate. If F maps the actual input's local metres into enclosing representation metres and s is the declared/admitted length scale, then p_local = inverse(F) * (s*p_source), n_local = transpose(F_linear) * n_source. The selected input is already physically baked for nonrigid maps; its actual frame is used once. Product placement and RTC are not reapplied. Existing presentation vectors, placements and source-frame metadata are copied through the derived logical output.

[buildingSMART's IfcHalfSpaceSolid definition](https://standards.buildingsmart.org/IFC/DEV/IFC4_3/HTML/lexical/IfcHalfSpaceSolid.html) specifies that AgreementFlag true means the BaseSurface normal points away from halfspace material. Consequently, BOTH runtime modes select occupied Negative for true and Positive for false. Difference removes that occupied side; Intersection retains it. Raw AgreementFlag and source normal are never inverted to hide this distinction. Wire mode remains truthful.

The unchanged exact path already keeps the positive normal side for true Difference. Exact Intersection currently routes the halfspace through unsupported operand handling, so admitted retained Intersection is new IFC semantics, not a claim of preserving previously supported exact Intersection clipping. Unbounded Union, polygonal/boxed subtypes, paired splits/layers remain explicit residuals.

## Full-host removal hold and remaining obligations

Exact `cut_heuristics::guard_against_full_host_removal` can keep an emptied host and report DifferenceEmptiedHost when any original mesh AABB corner is near the plane. Its tolerance is max(0.001 * diagonal, 0.001). A conservative plane-domain certificate does not authenticate that legacy decision. Neither display bounds nor a guessed domain policy replaces it.

A healthy actual SDK Difference Empty therefore returns typed Unsupported before ledger allocation, outcome binding, CAS or reply take. The sealed Empty receipt, original pending reply and live input ledger remain available. A captured cancellation/resource refusal wins over this compatibility hold. Intersection Empty binds to the original common reply and preserves lazy later-operand reach. This hold is a preservation gap, not completed support.

OpeningClosure, MaterialLayers, IfcAppearance and PersistentFaces requirements remain. No final product/export/viewer publication is enabled. Finite-domain clipping does not qualify cap ancestry, layer interface suppression, whole-product assembly, resource ceilings, mixed-controller stack safety, or performance. The exact default and existing numerical oracles are unchanged.
