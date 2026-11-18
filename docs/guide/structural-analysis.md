# Structural analysis

IFC structural analysis records describe an analytical model, its loads and its
relationship to physical elements. ifc-lite reads and authors these records. It
does not run a structural solver or certify a design.

The [coverage ledger](../architecture/structural-coverage-ledger.md) measures
support per entity and schema on a fixed corpus. A pass applies to that test,
not to every file. Reading, authoring and conversion have separate scores.
The ledger is frozen at a round boundary, so merged features can precede its
next measurement.

## Read and inspect

Open an IFC in the viewer. Select an analytical member or its linked physical element
in the model tree or viewport and inspect its Structural properties card.
For a member, related rows list connections, activities and analysis models.
Counterpart rows let you select the linked physical or analytical object.
The card is read-only. The ledger's card probes are still unwritten; a readable
record does not imply full card coverage.

IFC4 and IFC4X3 surface reinforcement results are available in the parser read
model as `reinforcementAreas`, including standalone records, and in the SDK as
`bim.structural.data().reinforcementAreas`. Their two ordered
reinforcement lists and optional shear ratio retain the file's values. A result
referenced by a load configuration also appears on the owning activity's card;
it can be inspected directly by its model-local express id.

Supports and loads appear as clickable glyphs when their geometry and values
can be resolved. Use **Supports & loads** in the command palette to toggle them.
All load groups are shown together; there is no load-case selector. Reaction
records can be read but do not have result glyphs. Curve and surface supports
and some load forms still have gaps, as the render column records. See
[glyph follow-ups #9828](https://github.com/LTplus-AG/ifc-lite/issues/9828).

From the terminal:

```bash
ifc-lite structural model.ifc
ifc-lite structural model.ifc --json > structural.json
```

The default output counts collections. JSON contains `analysisModels`,
`members`, `connections`, `loads` (actions with resolved `appliedLoad` values),
`loadGroups` (including cases), `reactions`, `resultGroups` and `links`.
Each link has a model-local `structuralItemId` and `physicalElementId`.
Records retain the parser read model's field names. Absent values stay absent;
the command adds no parsing or engineering inference. `hasStructural` reports
whether records were found and `loadsTruncated` reports bounded load walks.
This command reads only; redirect stdout to save JSON.
Run `ifc-lite validate model.ifc` for structural consistency warnings.

## Create, edit and remove

Loaded-model structural builders support IFC2X3, IFC4 and IFC4X3, with coverage
varying by entity. Use the ledger's create, edit and remove columns before
choosing a record type. Removal preserves shared resources and removes owned
subgraphs where supported; it is not a general graph repair operation.

In the viewer assistant, submit a supplied analytical graph proposal. Its review
offers model, curve member, point connection, load group, point and linear action creation and relationships.
Review native measures and the complete change list before Apply. Broader
creation, editing and removal are SDK operations; the read-only properties card
is not an editor for them.

For terminal automation, use `ifc-lite run script.js model.ifc` and the SDK's
`bim.store.addStructural*`, `editStructuralEntity` and `removeStructuralEntity`
methods. In `ifc-lite run`, write the returned export content with Node's file
API. Save this as `save.js` to rename the first member and write `edited.ifc`:

```javascript
const member = bim.structural.members()[0];
if (!member) throw new Error('This example needs a structural member');
bim.store.editStructuralEntity('default', member.expressId, { Name: 'Reviewed member' });
const { writeFile } = await import('node:fs/promises');
await writeFile('edited.ifc', bim.export.ifc());
```

Run `ifc-lite run save.js model.ifc` on a file with a structural member.
See [CLI scripting](cli.md) and the [TypeScript API](../api/typescript.md).

## Derive from physical elements

In the viewer command palette, choose **Derive structural analysis model**,
prepare the plan, inspect moved and unconnected ends, acknowledge the native
measures, then Apply. Derivation creates linked analytical records from beams,
columns, members, slabs and walls, with supports from footings. It is a geometric
starting point that needs engineering review.

Surface members carry readable through-openings as inner face bounds. Their
extrusion must be parallel or perpendicular to the plate normal within one
degree. A normal extrusion projects its profile onto the analytical mid-plane;
an in-plane extrusion sweeps the single interval cut through its profile. The
sections on both plate faces must match the mid-plane section within the derive
tolerance, so the opening spans the full thickness. Openings
within the derive tolerance of the outer boundary (such as doors at a wall base),
oblique openings, recesses, unreadable profiles and overlapping or touching
openings are skipped with reasons in `plan.report.skippedOpenings` (opening id, host id and reason),
counted separately in `report.counts.skippedOpenings`; `report.skipped` and
`report.counts.skipped` describe physical elements only. Both IfcOpeningElement
and IfcOpeningStandardCase are accepted. Through checks use the derive tolerance
in metres and sample the actual plate faces, including slightly oblique slabs.
Profile voids are not carried.
The loaded-model surface builder also accepts `Openings: Point3D[][]` alongside
`Boundary`; each ring must be simple, coplanar and strictly inside the boundary,
with no overlap or contact between rings.

```bash
ifc-lite derive-structural model.ifc --dry-run --json
ifc-lite derive-structural model.ifc --out analytical.ifc
```

The default refuses a file that already has an analysis model. Use
`--analysis-model-exists add` only when you intend to add missing counterparts.
Run `ifc-lite derive-structural --help` for tolerance and support options.

Each derived curve member carries an `IfcLite_StructuralDerivation` property
set with its element's GlobalId and that element's analytical line at derive
time, in metres in the storey's axes, so moving a storey or site that
carries both the element and the member is not a change.
`structuralConsistencyIssues(store, { physicalAxes })` compares it with the
element's line now and reports `structural-stale-item` when the element moved
more than `staleTolerance` (default 1 mm), including a move along its own
axis. Members derived before this record existed, and
surface members and nodes, are not checked.
`structuralConsistencyReport(store, { physicalAxes })` returns the same issues
plus `coverage`: the number of linked curve members, and each one the
axis-drift or movement rule skipped, with the reason per rule
(`edge-unreadable`, `no-derivation-record`, `element-without-axis`,
`recorded-element-unlinked`).
`ifc-lite validate` reports them as `structural-unchecked-member`.

## Convert and known limits

Start with an IFC2X3 file, here named `model-2x3.ifc`. Read its structural
records, convert a copy to IFC4, and inspect the loss report and output:

```bash
ifc-lite structural model-2x3.ifc --json
ifc-lite convert model-2x3.ifc --schema IFC4 --out model-4.ifc
ifc-lite structural model-4.ifc --json
```

Downgrading to IFC2X3 refuses resource types that it cannot represent, such as
`IfcMaterialProfileSet` and an `IfcStructuralLoadConfiguration` that no varying
action takes (below). Inspect the loss report before relying on a conversion.

IFC2X3's `IfcStructuralLinearActionVarying` and
`IfcStructuralPlanarActionVarying` become an IFC4 curve or surface action with
`PredefinedType` `NOTDEFINED` and an `IfcStructuralLoadConfiguration` holding
the loads without `Locations`. The `IfcShapeAspect` that places them stays on
the action's representation, so the downgrade writes the varying action back.
Both directions convert an action only when the other one can convert it back:
its representation has exactly one `IfcShapeAspect`, and its loads share one
type the IFC2X3 action admits. An IFC4 action also needs a `PredefinedType` of
`NOTDEFINED`, `LINEAR` or `POLYGONAL` (curve) or `NOTDEFINED` or `BILINEAR`
(surface): values linear between their locations. Other actions keep their
previous handling.
Both need an unedited full export.

Four other values move between an attribute and a relationship or property set:

- An IFC2X3 action's `CausedBy` becomes an `IfcRelAssignsToProduct` named
  `Causes` from the action to the reaction, as IFC4 holds it. The downgrade
  keeps that relationship and fills `CausedBy` when it names one point reaction.
- An IFC4 `IfcStructuralLoadCase` becomes an `IfcStructuralLoadGroup` with an
  `IFC4 IfcStructuralLoadCase` property set holding `SelfWeightCoefficients`.
  The upgrade turns a `LOAD_CASE` group carrying it back into the load case.
- The upgrade writes `IfcStructuralAnalysisModel.SharedPlacement` when the
  grouped structural items use one placement, or equal copies of one, and places
  each item on a copy by that placement. It fills this even where the IFC4
  source left it empty.
- An IFC2X3 varying surface member with three thicknesses gets
  `Pset_StructuralSurfaceMemberVaryingThickness` (`Thickness1` to
  `Thickness3`) when its location is the one aspect of the member's
  representation and each of that aspect's representations holds one point,
  which is where the downgrade finds it again. Otherwise both are reported lost,
  also when the member already has a matching property set. The downgrade
  reads an IFC4 member's property set with that one point aspect as its
  location, unless the set gives `Location` properties: their order cannot be
  checked against the aspect, so the thicknesses are reported and not written.

These also need an unedited full export.

The viewer's read and review surfaces do not provide a structural schema
conversion editor. Conversion is not lossless for all records. The ledger
checks IFC2X3 to IFC4 and back, and IFC4 to IFC2X3 and back, separately.
IFC4X3 conversion is outside that measurement. Some attributes remain unproven
because the corpus never sets them. See the per-row reasons, plus
[converter tokenizer #9856](https://github.com/LTplus-AG/ifc-lite/issues/9856)
and [literal labels #9876](https://github.com/LTplus-AG/ifc-lite/issues/9876).

## Entity scope

The following IFC4 catalogue names identify the measured domain, not a promise
that every operation supports every entity. Consult the ledger for each cell.

- item: `IfcStructuralCurveConnection`, `IfcStructuralCurveMember`, `IfcStructuralCurveMemberVarying`, `IfcStructuralPointConnection`, `IfcStructuralSurfaceConnection`, `IfcStructuralSurfaceMember`, `IfcStructuralSurfaceMemberVarying`.

- activity: `IfcStructuralCurveAction`, `IfcStructuralCurveReaction`, `IfcStructuralLinearAction`, `IfcStructuralPlanarAction`, `IfcStructuralPointAction`, `IfcStructuralPointReaction`, `IfcStructuralSurfaceAction`, `IfcStructuralSurfaceReaction`.

- group: `IfcStructuralAnalysisModel`, `IfcStructuralLoadCase`, `IfcStructuralLoadGroup`, `IfcStructuralResultGroup`.

- resource: `IfcBoundaryEdgeCondition`, `IfcBoundaryFaceCondition`, `IfcBoundaryNodeCondition`, `IfcBoundaryNodeConditionWarping`, `IfcConnectionPointEccentricity`, `IfcFailureConnectionCondition`, `IfcSlippageConnectionCondition`, `IfcStructuralLoadConfiguration`, `IfcStructuralLoadLinearForce`, `IfcStructuralLoadPlanarForce`, `IfcStructuralLoadSingleDisplacement`, `IfcStructuralLoadSingleDisplacementDistortion`, `IfcStructuralLoadSingleForce`, `IfcStructuralLoadSingleForceWarping`, `IfcStructuralLoadTemperature`, `IfcSurfaceReinforcementArea`.

- relationship: `IfcRelConnectsStructuralActivity`, `IfcRelConnectsStructuralMember`, `IfcRelConnectsWithEccentricity`.
