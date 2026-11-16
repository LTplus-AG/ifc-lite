# R10 convert carriers and point-action CausedBy

Product source: branch from main `5edf312b07` (after R9, #10548). R10 adds structural conversion carriers in `packages/export`, one convert-probe correction, and the IFC2X3 point-action `CausedBy` fixture from the point-action lane (branch `structural-climb/pointaction-causedby`). R0 to R9 are retained.

Rows: **106/119 -> 109/119** (met 93 -> 99, partial 26 -> 20, missing 0 -> 0). Cells: **756/774 -> 759.5/774**. Read: 109.5/110 -> 110/110; card: 99.5/100 -> 100/100; convert: 56/72 -> 58.5/72. All other level totals are unchanged. The online ratchet against R9 passes with no row or cell dropped.

## Every changed cell

The full summary comparison against R9 has exactly eight changed cells, including the one reason-only change; the point-action convert row is listed for context.

| Row | Level | R9 -> R10 | Why |
|---|---|---|---|
| IFC2X3/IfcStructuralPointAction | read | partial -> pass | Fixture: generated point action #48 now sets `CausedBy` to point reaction #66. The unchanged read probe sees the populated reference. |
| IFC2X3/IfcStructuralPointAction | card | partial -> pass | Same fixture change; the unchanged card probe shows it. |
| IFC2X3/IfcStructuralPointAction | convert | pass -> pass | With the fixture alone this cell drops to partial (`CausedBy` null after the round trip). The product fix below keeps it at pass. |
| IFC2X3/IfcStructuralLinearAction | convert | partial -> pass | Product: IFC4 deleted `CausedBy` and holds it as an `IfcRelAssignsToProduct` named `Causes` (IFC4 IfcStructuralAction change note). The upgrade writes that relationship; the downgrade fills `CausedBy` from it. #50 and #72 now come back with reaction `0KQ0efL39PrP5DeqBwaUNp`. |
| IFC2X3/IfcStructuralPlanarAction | convert | partial -> pass | Same `CausedBy` carrier; #52 now comes back. |
| IFC2X3/IfcStructuralSurfaceMemberVarying | convert | partial -> pass | Product: IFC4 gives varying thickness by `Pset_StructuralSurfaceMemberVaryingThickness` (IFC4 IfcStructuralSurfaceMemberVarying). When the location is the one point `IfcShapeAspect` of the member's representation (IFC2X3 WR62, WR63), the upgrade writes Thickness1 to Thickness3 and the downgrade restores `SubsequentThickness` with that aspect as the location; otherwise both are reported lost. Fixture #40's aspect #38 qualifies. |
| IFC4/IfcStructuralLoadCase | convert | partial -> pass | Product: the downgrade writes an `IfcStructuralLoadGroup` with an `IFC4 IfcStructuralLoadCase` property set holding `SelfWeightCoefficients`; the upgrade restores the load case and leaves the set out. All four records come back as the load case with their coefficients. |
| IFC4/IfcBoundaryEdgeCondition | convert | partial -> pass | Probe correction (below). |
| IFC4/IfcStructuralAnalysisModel | convert | partial -> partial (reason) | Product: the upgrade writes `SharedPlacement` when the grouped items use one local placement or equal copies (IFC4 informal proposition 2; IFC2X3 gives each product its own placement record). slab_01 #19 now comes back. beam_01 #72 left it empty in the IFC4 source, so it now comes back filled: the IFC2X3 file cannot say it was empty. IFC4's informal proposition 1 says it shall be provided when items are grouped. |

## Probe correction

`probes/convert.mjs`: in an IFC4 resource row, an `IfcBoolean` false in one of IFC4's six stiffness SELECTs may come back as the zero measure. IFC2X3 holds these values as a plain REAL where 0 means free and -1 rigid, so false and a zero measure (both free) become the same `0.` and the upgrade writes the measure. The excuse is keyed on the slot's declared IFC4 type, nothing else. Records affected: slab_01 #74 and #79, structure_01 #107 and #163.

Regression test: `convert (#9668): an IFC4 stiffness false may come back as the zero measure IFC2X3 forces, and nothing else is excused` in `scripts/generate-structural-coverage-ledger.test.mjs`. Against the R9 probe it fails (the false-to-zero case is rejected); against the R10 probe it passes, and it still rejects a non-zero measure, a swapped slot, an empty slot and a non-stiffness slot.

## Fixture

`scripts/fixtures/generate-structural-edge-curve.py --coverage IFC2X3`, regenerated with IfcOpenShell `0.8.3.post2`. The only STEP change is `#48.CausedBy`: `$` -> `#66`. Size 10374 -> 10376 bytes; SHA-256 `1b6251e1...` -> `80bc135dadc88105f191a24fecf081f8452b0646787676b75332762ddc725d18` (`tests/models/manifest.json`).

## Convert cells still not met, with the evidence

- IFC2X3 curve connection, curve member, curve member varying: IFC4 requires `Axis`; the IFC2X3 source has no section orientation (no `ProfileOrientation`), and writing one would invent it.
- IFC2X3 linear and planar varying actions (and so IFC2X3 IfcRelConnectsStructuralActivity): the generated fixture's location aspect has one representation for three loads, against the IFC2X3 definition that they correspond by index. The converter requires the counts to match (`schema-converter-structural-varying.test.ts`, case B).
- IFC4 curve and surface reactions: IFC2X3 IfcStructuralReaction is `ONEOF(IfcStructuralPointReaction)`.
- IFC4 curve action and IfcStructuralLoadConfiguration: the configurations hold `Locations` and one action has no representation; IFC2X3 can only hold varying loads located by an `IfcShapeAspect` on a representation.
- IFC4 IfcSurfaceReinforcementArea: no IFC2X3 entity; the converter refuses the file by design.
- IFC4 curve member and surface member (generated files): no `IfcOwnerHistory` in the source; IFC2X3 requires one and the converter does not invent one (#4686).
- IFC4 curve connection and curve member varying `Axis`: no IFC2X3 slot.
- IFC4 surface member varying: the source has no thickness data; IFC2X3 requires `SubsequentThickness` LIST [2:?].
- IFC4 IfcStructuralAnalysisModel: beam_01 #72 left `SharedPlacement` empty, and IFC2X3 cannot record that it was.
