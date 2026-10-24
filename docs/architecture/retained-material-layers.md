# Retained material layer source contract

The opt-in shared native/browser product controller captures source bindings for
`IfcMaterialLayerSetUsage`. `RuntimeProductWitness::layer_source()` exposes the
read-only `RetainedLayerSource` of an intermediate witness. This is **not a J3
numerical continuation**. `MaterialLayers` and persistent-face obligations remain
pending, and final publication remains refused.

Admission uses the authenticated decoder and snapshot, with a snapshot-owned
association index. It retains association, usage, layer-set, ordered layer and
material ids; product placement from `resolve_scaled_placement_strict`; units;
direction; and contiguous scalar boundary offsets. Invalid thickness, nonfinite
or collapsed boundaries, missing references and ambiguous usages refuse the
whole product. An explicitly absent optional material is an air gap. Source
layers are not visually merged. The existing exact display index is unchanged.

A `RetainedLayerInterface` describes an unfulfilled boundary between two source
bands. It cannot identify an SDK face or authorize removing a cap. No source
face is relabeled as generated, and no empty band is manufactured from source
metadata. Numerical receipt authentication and full-removal policy remain the
existing controller's responsibility.

For walls the reference is the source Axis curve, including circular axes. A
wall's scalar offsets cannot be interpreted as Y-coordinate planes around an
entire arc. This follows the [buildingSMART wall geometry and material usage
definition](https://raw.githubusercontent.com/buildingSMART/IFC4.3.x-development/master/docs/schemas/shared/IfcSharedBldgElements/Entities/IfcWall.md).
Other products retain the declared product axis as source metadata; this does
not certify body eligibility or thickness coverage. Mapped geometry, trimmed
curves and source/body agreement still need geometric validation.

## Numerical prerequisite

`RetainedUnaryClip` currently requires `RetainedPlaneSource` with authored
Boolean/halfspace/surface/placement ids. A generated material interface is not
an authored `IfcHalfSpaceSolid`. It needs a distinct source-bound operation
provenance contract, carried through issuance, native and browser invocation,
receipt verification and per-band completion. Reusing plane clipping requires
that extension; fabricating STEP ids or a halfspace recipe is not acceptable.

Circular wall offsets also need a qualified circular-offset operation or a
source-derived finite annular-sector constructor intersected with the **net
host after openings**. The source must prove the circle/trim orientation,
placement, units, radial extent, extrusion extent and coverage. Arbitrary
curves need their own offset/region proof. No infinite approximate cutter or
mesh fallback is introduced here. These prerequisites are not supplied by
bounded/boxed halfspace support alone.

Every accepted band must authenticate its numerical result, material binding,
ordinal and common source revision, including Empty. Both siblings of each
interface must be accounted for; complete coverage, no overlap and retained
external boundaries must be proved before discharging `MaterialLayers`.
Intermediate capped solids remain permitted. J5 persistent face ancestry and
internal cap removal remain separate unmet gates.

## Fixed test definitions

`tests/evidence/retained-layers-j3/` contains a circular slab and independent
two/three-layer circular walls with an annular-sector opening crossing every
band. `curved-oracles.json` fixes analytic per-band net volumes and tolerances
before any runtime execution. For the wall axis radius 10, positive offsets
point inward; the three bands have radii 10, 9.5, 8.5, 7. The two-band case has
radii 10, 9, 7. The sector angle is pi/2, wall height 3, opening angle pi/6 and
opening height 1. Each net band volume is
`(3*pi/2 - pi/6) * (outer_radius^2 - inner_radius^2) / 2`.
These are future numerical oracle definitions, **not executed layer tests**.

Source tests cover actual decoded layer order, air gaps, thin bands, negative
direction, millimetres, curved reference identity, malformed stacks, source
revision and budget failure. Native and actual Worker tests define an uncut
curved-host continuation with the source bands retained and J3 explicitly
unmet. They do not validate partition geometry. CI invokes four independent
source-semantic reverse mutations and requires their named assertion failures,
rejecting compiler failures, skips and zero-test runs. All Rust/SDK/Worker and
mutation executions require the parent validation run; source preparation alone
is not a passed gate.

No performance verdict has been measured. Default feature-off code is unchanged;
its byte identity and the protected corpus still require qualification. The
association index scans once per snapshot, not once per product, but that new
retained-path cost and memory must be measured before landing.
