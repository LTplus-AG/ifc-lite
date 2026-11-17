# R12 final round

Product source: main `75948a3d48` (R11). There are no product changes. R12 fixes the IFC2X3 coverage fixture generator and adds limits (`tests/structural-coverage/limits.mjs`), which label the problems no product change can fix. R0 to R11 are retained.

Rows: **109.5/119 -> 111/119** (met 100 -> 103, partial 19 -> 16, missing 0 -> 0). Cells: **760/774 -> 762/774**. Convert: 58.5/72 -> 60.5/72. All other level totals are unchanged. The online ratchet against R11 passes with no row or cell dropped.

Of the 16 cells not met: 12 out of reach (schema), 1 policy-limited, 1 upstream, 2 reachable.

## Every changed cell

The full summary comparison against R11 has three score changes and 15 cells that gain a `limits` label. No reason string changed.

| Row | Level | R11 -> R12 | Why |
|---|---|---|---|
| IFC2X3/IfcStructuralLinearActionVarying | convert | partial -> pass | Fixture (below). The varying action now has one location per load, so `StructuralVarying` converts it to an IFC4 curve action with a load configuration, and the downgrade restores it record for record. |
| IFC2X3/IfcStructuralPlanarActionVarying | convert | fail -> pass | Same fixture fix, for the planar action. |
| IFC2X3/IfcRelConnectsStructuralActivity | convert | partial -> pass | Two of its relationships named the varying actions, which stayed IFC2X3 entities in the IFC4 file. They now name IFC4 curve and surface actions. |

Cells that gain a label and keep their status and points: the 14 marked out of reach, policy-limited or upstream in the table below, plus IFC4/IfcStructuralCurveMember convert (its OwnerHistory problem is labelled policy and its `Axis` problem stays open).

## Fixture

The generator wrote each IFC2X3 varying record's `IfcShapeAspect` with one point representation and three values: `AppliedLoad` plus two `SubsequentAppliedLoads` (`VaryingAppliedLoads` LIST [2:?] linear, [3:?] planar, IFC2X3_TC1.exp:7317, :7432), and `Thickness` plus two `SubsequentThickness` (IFC2X3_TC1.exp:7525). IFC2X3 locates those values by index, one shape representation per value. The converter refuses a count mismatch (`schema-converter-structural-varying.test.ts`, case B, unchanged), so the generator was wrong, not the converter.

`scripts/fixtures/generate-structural-edge-curve.py`: `aspect()` takes one point per value. The linear action's loads sit at x = 0, 2.5 and 5 along the curve member's edge; the planar action's and the surface member varying's thicknesses sit at three corners of their faces. `SPAN` moved up so these use it.

Regenerated with IfcOpenShell `0.8.3.post2` (`--coverage IFC2X3`). Before editing, the same environment reproduced the R11 bytes exactly (only the header file name differed with a different output name). The IFC4, IFC4X3 and reinforcement files regenerate byte-identical. IFC2X3: 10376 -> 11099 bytes, SHA-256 `80bc135d...` -> `95f96b3946e0c21e23bd727e39ca42635b7dd79045de309994848502737d7904`, uploaded to `fixtures-v1` as an asset named by that hash (added, nothing overwritten); `pnpm fixtures:check` passes with all 221 fixtures. Records after the first aspect are renumbered: `structural-consistency.test.ts` (#40 -> #45) and `structural-command.test.ts` (beam #88 -> #103, link #89 -> #104) follow.

The surface member varying keeps passing: the R10 thickness carrier takes any aspect whose representations are each one point (WR62, WR63).

## Regression evidence

- `schema-converter-structural-varying.test.ts`, `converts the IFC2X3 coverage fixture varying actions both ways`: on the R11 fixture it fails (the upgrade leaves both actions as IFC2X3 entities); on the R12 fixture it passes, and both records come back byte for byte. Case B (the refusal) is unchanged and passes.
- `scripts/generate-structural-coverage-ledger.test.mjs`, `limits (#9668): ...`: a limit labels only the problems it matches and counts the rest open; a limit whose fact does not hold, that matches nothing, that sits on a passing cell or names no cell throws; a labelled cell scores the same. A second test checks every limit names a catalogue row, an applicable level, a kind and a citation.
- Every limit's fact is checked on the real corpus in each complete run. Writing the reaction check exposed an error of mine (it skipped the CONST curve and surface reactions as if they mapped like CONST actions); the check refused the run until it was fixed.

## The 19 R11 partial rows

| Row | Cell | R12 | Evidence |
|---|---|---|---|
| IFC2X3/IfcRelConnectsStructuralActivity | convert | moved | above |
| IFC2X3/IfcStructuralLinearActionVarying | convert | moved | above |
| IFC2X3/IfcStructuralPlanarActionVarying | convert | moved | above |
| IFC2X3/IfcStructuralCurveConnection | convert | out of reach (schema) | IFC4 `Axis : IfcDirection` is required (IFC4_ADD2_TC1.exp:9415). The IFC2X3 entity declares no attribute (IFC2X3_TC1.exp:7277), and IFC2X3 gives a connection no orientation. |
| IFC2X3/IfcStructuralCurveMember | convert | out of reach (schema) | IFC4 `Axis` is required (IFC4_ADD2_TC1.exp:9423); IFC2X3 has none (IFC2X3_TC1.exp:7281). The upgrade fills it from `IfcRelAssociatesProfileProperties.ProfileOrientation` (IFC2X3_TC1.exp:6548), as the roof truss shows, but the generated record has no profile orientation, so filling it would invent it. |
| IFC2X3/IfcStructuralCurveMemberVarying | convert | out of reach (schema) | Same as the curve member. |
| IFC4/IfcRelConnectsStructuralActivity | convert | out of reach (schema) | IFC2X3 `RelatedStructuralActivity : IfcStructuralActivity` (IFC2X3_TC1.exp:6610). Relationships #72, #77 and #78 name the LINEAR curve action and the curve and surface reactions, which IFC2X3 holds only as `IfcProxy`. |
| IFC4/IfcStructuralAnalysisModel | convert | out of reach (schema) | IFC2X3 has no `SharedPlacement` (IFC2X3_TC1.exp:7251). beam_01 #72 left it empty and slab_01 #19 set it; both give the same IFC2X3 file, so at most one can come back. The upgrade fills it, as IFC4 informal proposition 1 asks. |
| IFC4/IfcStructuralCurveAction | convert | out of reach (schema) | No IFC2X3 curve action (IfcStructuralAction ONEOF, IFC2X3_TC1.exp:7230). The IFC2X3 varying action has no `PredefinedType` (:7312), so #51 and #317 (LINEAR) cannot come back LINEAR without turning NOTDEFINED ones LINEAR. Their configurations hold `Locations`, which IFC2X3 has no slot for, and #317 has no representation for an `IfcShapeAspect` to belong to. |
| IFC4/IfcStructuralCurveConnection | convert | out of reach (schema) | `Axis` (IFC4_ADD2_TC1.exp:9415) has no IFC2X3 slot or carrier (IFC2X3_TC1.exp:7277). |
| IFC4/IfcStructuralCurveMember | convert | policy-limited, and reachable | Task 1. `generated_structural_edge_curve.ifc` (2 of 2) has no `IfcOwnerHistory`: OPTIONAL in IFC4 (IFC4_ADD2_TC1.exp:8891), required in IFC2X3 (IFC2X3_TC1.exp:6905), never invented (#4686). With an owner history added in a scratch copy the records conform, but `Axis` still comes back empty. That `Axis` loss, and beam_01 #86's, is reachable: see Deferred. |
| IFC4/IfcStructuralCurveMemberVarying | convert | reachable | #33 `Axis` is lost. See Deferred. |
| IFC4/IfcStructuralCurveReaction | convert | out of reach (schema) | IFC2X3 IfcStructuralReaction is ONEOF(IfcStructuralPointReaction) (IFC2X3_TC1.exp:7480). |
| IFC4/IfcStructuralLoadConfiguration | convert | out of reach (schema) | No IFC2X3 entity. IFC2X3 locates varying loads only by `IfcShapeAspect` representations (IFC2X3_TC1.exp:7314), so `Locations` (IFC4_ADD2_TC1.exp:9473), which all five records set, has no slot. |
| IFC4/IfcStructuralSurfaceMember | convert | policy-limited | Task 1. `generated_structural_surface_member.ifc` (1 of 1) has no `IfcOwnerHistory` (same citations). With one added in a scratch copy the record conforms and comes back equal, so OwnerHistory is the only blocker. The product (reuses an owner history, never invents one) and the probe (the IFC2X3 file does not conform) are both right. |
| IFC4/IfcStructuralSurfaceMemberVarying | convert | out of reach (schema) | IFC2X3 requires `SubsequentThickness` LIST [2:?] and `VaryingThicknessLocation` (IFC2X3_TC1.exp:7522, :7523). The generated IFC4 record has no `Pset_StructuralSurfaceMemberVaryingThickness`, so filling them would invent thicknesses. |
| IFC4/IfcStructuralSurfaceReaction | convert | out of reach (schema) | As the curve reaction (IFC2X3_TC1.exp:7480). |
| IFC4/IfcSurfaceReinforcementArea | convert | out of reach (schema) | No IFC2X3 entity, and it is no IfcRoot, so it cannot become an `IfcProxy`; the converter refuses the file by design. |
| IFC4X3/IfcStructuralPointReaction | render | upstream | `puntal-alfa/portal-demo.ifc` #161 and #163 have no ObjectPlacement, no Representation and no `IfcRelConnectsStructuralActivity` (R9 notes). The exporter should connect each reaction to its point connection. Not fixed here. |

Both task 1 fixtures are valid IFC4 #4206 geometry fixtures. Adding an owner history to them would move a cell without the product doing anything new, so they stay as they are.

## Deferred

- **IFC4 -> IFC2X3 `Axis` of a curve member** (beam_01 #86, generated IFC4 #33, the edge-curve file). Reachable: IFC2X3 can hold it as `IfcRelAssociatesProfileProperties.ProfileOrientation`, which the upgrade already reads. Not written, because the downgrade would have to add an `IfcGeneralProfileProperties` with no values that the source never had, and the upgrade reads orientation only on unplaced members, so placed members also need a frame transform. This needs a decision on writing that record.
- Rust parity in `rust/export` for the structural carriers.
- The carried-attribute exclusion in `schema-conversion-loss-report.ts`.
