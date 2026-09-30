# Property Editing

IFClite supports editing IFC properties in-place with full change tracking, undo/redo, and export. The `@ifc-lite/mutations` package provides the mutation infrastructure, while the viewer integrates it with a property editor UI.

## How It Works

Mutations are tracked through a **MutablePropertyView** that wraps the original read-only property table. When you edit a property:

1. The original value is preserved
2. The new value is stored in an overlay
3. Reads return the mutated value transparently
4. All changes are tracked as a `Mutation` with old/new values
5. Changes can be exported, applied to other models, and shared via change sets

## Quick Start

### Editing Properties

```typescript
import { MutablePropertyView } from '@ifc-lite/mutations';

// Create a mutable view over the property table
// Parameters: (baseTable: PropertyTable | null, modelId: string)
const view = new MutablePropertyView(propertyTable, 'my-model');

// Set a property value
const mutation = view.setProperty(
  entityId,             // Express ID of the entity
  'Pset_WallCommon',    // Property set name
  'FireRating',         // Property name
  'REI 120',            // New value
);

console.log(`Changed from "${mutation.oldValue}" to "${mutation.newValue}"`);

// Read the mutated value
const value = view.getPropertyValue(entityId, 'Pset_WallCommon', 'FireRating');
// Returns 'REI 120'
```

### Changing a property's declared IFC type

The fifth argument is the property's `PropertyValueType`. Most of its members
are *shapes* (`String`, `Real`, `Integer`, …) — what the parser collapses a
source token into — but `Label`, `Identifier` and `Text` each *name* one
`IfcValue` member, so passing one of those sets the type the exported file
declares:

```typescript
import { PropertyValueType } from '@ifc-lite/data';

// A value that outgrew IfcLabel's 255 characters: export it as IfcText.
view.setProperty(entityId, 'Pset_WallCommon', 'Reference', 'a long description…', PropertyValueType.Text);
```

The exported line becomes `IFCTEXT('…')` where the source declared
`IFCLABEL('…')` — which is what an IDS `property` facet with
`dataType="IFCTEXT"` checks.

Passing a *shape* instead leaves the declared type alone: a value-only edit
(`String`, the default) keeps whatever token the source line carried, so
re-serializing a property set never rewrites the declared types of the
neighbours you did not touch. For the same reason a numeric type cannot be
changed this way — `Real` names neither `IfcLengthMeasure` nor `IfcReal`, so
the source token wins.

### Mutation History

```typescript
// Get all mutations applied to this view
const mutations = view.getMutations();

// Check if an entity has changes
const hasChanges = view.hasChanges(entityId);

// Get count of modified entities
const count = view.getModifiedEntityCount();

// Clear all mutations (reset to original state)
view.clear();
```

> **Note:** Undo/redo is handled by the viewer's store (mutationSlice), not directly on MutablePropertyView. In the viewer, use Ctrl+Z / Ctrl+Shift+Z.

Whole-set edits (`createPropertySet`, `deletePropertySet`, `createQuantitySet`, `deleteQuantitySet`, `deleteQuantity`) record the set's overlay rows before and after the edit on the returned mutation's `setOverlay`. A host with its own undo history reverts or re-applies one of them with `view.restoreSetOverlay(mutation.setOverlay.before)` / `(...after)`, which is what the viewer does.

### Enumerating the live entity set

The parsed store's type index describes the file as loaded. After a session
creates, deletes, or retypes entities, use the effective iterator for queries
over that session. Pass schema-expanded, uppercase IFC type names when filtering;
omit the third argument to visit every effective entity.

```typescript
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';

for (const { expressId, type, overlayCreated } of iterateEffectiveEntityIds(dataStore, view, ['IFCWALL'])) {
  console.log(expressId, type, overlayCreated);
}
```

The iterator yields source entities in parsed order, followed by source entities
retyped into a requested class, then overlay-created entities. Tombstones are
excluded in every case.

When a query already has source candidates from an immutable index, add
`view.getAttributeOverrideEntityIds()` to catch source entities whose live
attributes or type differ from the file. This returns a snapshot of current
named, positional and type override IDs, including edits made without journal
records. Apply effective reads to these candidates; the list alone does not
exclude deletions or validate an attribute's meaning. Passing the combined
source candidates as the iterator's fourth argument restricts source traversal
while still including overlay creations.

For direct members of a spatial container, `@ifc-lite/parser` also exports
`effectiveSpatialMemberIds(store, containerId, context)`. Supply a context
containing the model's `resolveEffectiveRelationshipOverlay` result, an
`isDeleted` callback, and an effective `typeName` callback for a live session.
It follows edited and created `IfcRelContainedInSpatialStructure` records,
filters deleted products and spatial child nodes, and returns only direct
members. Without a context it reads the parsed spatial hierarchy snapshot.

`effectiveStoreyId(store, expressId, context)` uses the same context to find a
product's containing storey through edited containment and aggregate ancestors.
It returns `undefined` if the product is deleted or no longer contained. With
no context, it reads the parsed `elementToStorey` snapshot.

For per-class totals, `countEffectiveEntityTypes` applies the same membership
and class changes. It returns a map keyed by uppercase IFC class and keeps a
zero entry when all source entities of a class were deleted or retyped.

```typescript
import { countEffectiveEntityTypes } from '@ifc-lite/data';

const wallCount = countEffectiveEntityTypes(dataStore, view).get('IFCWALL') ?? 0;
console.log(wallCount);
```

### Change Sets

Change sets group related mutations for export and sharing:

```typescript
import { ChangeSetManager } from '@ifc-lite/mutations';

const manager = new ChangeSetManager();

// Create a change set (becomes the active change set)
const changeSet = manager.createChangeSet('Fire Safety Updates');

// Add mutations to the active change set
manager.addMutation(mutation1);
manager.addMutation(mutation2);

// Export as JSON
const json = manager.exportChangeSet(changeSet.id);

// Import on another instance
const imported = manager.importChangeSet(json);
```

## Bulk Operations

For updating many entities at once, use the `BulkQueryEngine`. Evaluate property filters with `@ifc-lite/rules`, then pass the selected Express IDs in `select.expressIds`:

```typescript
import { BulkQueryEngine } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

// Constructor requires EntityTable and MutablePropertyView
const engine = new BulkQueryEngine(entityTable, mutationView);

// Define a bulk query - which entities to update and how
const query = {
  select: {
    entityTypes: [10],    // Type enum values (e.g., IfcWall)
  },
  action: {
    type: 'SET_PROPERTY' as const,
    psetName: 'Pset_WallCommon',
    propName: 'ThermalTransmittance',
    value: 0.18,
    valueType: PropertyValueType.Real,
  },
};

// Preview changes before applying
const preview = engine.preview(query);
console.log(`Will update ${preview.matchedCount} entities`);

// Apply
const result = engine.execute(query);
console.log(`Updated ${result.affectedEntityCount} properties`);

// Root attributes: one of BULK_WRITABLE_ATTRIBUTES (Name, Description, ObjectType, Tag)
const retagged = engine.execute({
  select: { expressIds: [42, 43] },
  action: { type: 'SET_ATTRIBUTE' as const, attribute: 'ObjectType', value: 'Partition' },
});
console.log(retagged.success ? 'ObjectType set' : retagged.errors);
```

`SET_ATTRIBUTE` takes the exact EXPRESS attribute name. An entity whose class does not declare the attribute (for example `ObjectType` on a type object) is reported in `errors` rather than skipped. Pass the model's `schemaVersion` as the engine's last constructor argument to judge that against the file's own schema.

## CSV Import

Import property updates from spreadsheets:

```typescript
import { CsvConnector } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

// Constructor requires EntityTable and MutablePropertyView
const connector = new CsvConnector(entityTable, mutationView);

// Parse CSV (returns CsvRow[])
const rows = connector.parse(csvString, {
  delimiter: ',',
  hasHeader: true,
});

// Define mapping from CSV columns to IFC properties
const mapping = {
  matchStrategy: { type: 'globalId' as const, column: 'GlobalId' },
  propertyMappings: [
    { sourceColumn: 'Fire Rating', targetPset: 'Pset_WallCommon', targetProperty: 'FireRating', valueType: PropertyValueType.String },
    { sourceColumn: 'U-Value', targetPset: 'Pset_WallCommon', targetProperty: 'ThermalTransmittance', valueType: PropertyValueType.Real },
  ],
};

// Import (takes CSV string directly, not pre-parsed rows)
const stats = connector.import(csvString, mapping);
console.log(`Matched: ${stats.matchedRows}, Updated: ${stats.mutationsCreated}, Skipped: ${stats.unmatchedRows}`);

// Async variant: yields between batches and reports each applied batch
const asyncStats = await connector.importAsync(csvString, mapping, (progress) => {
  console.log(`${progress.phase}: ${Math.round(progress.percent * 100)}%`);
}, {
  onApplied: (mutations) => console.log(`Applied ${mutations.length} writes`),
});
```

The importer writes straight to the view. `stats.mutations` lists every write that landed, including those applied before an error ended the import (`stats.errors`), so a host with undo history can revert them. `onApplied` lets it record that history batch by batch as the import goes.

## Viewer Integration

In the IFClite viewer:

1. **Select an entity** in 3D or the hierarchy panel
2. **Open Properties panel** — Edit properties directly in the panel
3. **Bulk edit** — Use the Property Editor to update multiple entities
4. **Review changes** — Open **Changes** in the sidebar to see edits by model and entity; Bulk and CSV batches appear as one operation
5. **Jump or revert** — Jump selects and frames an edited entity. Revert uses Undo for the newest operation; an older independent edit is reversed as a new undo step. If newer edits depend on it, the drawer refuses the reversal. Leave a shared room before reverting; room sync cannot publish these local history reversals yet.
6. **Undo/Redo** — Ctrl+Z / Ctrl+Shift+Z to undo/redo edits
7. **Export** — Use **Export modified IFC…** or **Changes only (JSON delta)** from Changes. Both open the viewer's existing export flow.

### Properties panel tabs

Use **Find properties** to narrow attributes, property sets, and quantities by
name or value. Matching rows are highlighted, and matching sections open while
the search is active. Section chevrons keep your collapsed or expanded choice
when you select another element or reopen the viewer.

| Tab | Edits | Backed by |
|---|---|---|
| **Properties** | IfcRoot named attributes (Name, Description, …), property sets, classifications, materials, documents | `setProperty` / `setAttribute` |
| **Quantities** | Quantity sets and individual quantities | `setQuantity` / `deleteQuantity` / `createQuantitySet` / `deleteQuantitySet` |
| **bSDD** | Add buildingSMART Data Dictionary properties | `setProperty` |
| **Raw STEP** | Positional STEP arguments on the selected entity (one row per arg, inline pen-icon editor). Mutated rows show a purple dot. | `setPositionalAttribute` |

The Raw STEP tab is the right place for non-IfcRoot edits — `IfcRectangleProfileDef.XDim`, `IfcCartesianPoint.Coordinates`, anything without a symbolic attribute name.

### Zone shapes

A zone is an oriented box by default. A zone whose JSON carries a `footprint` (an array of `[x, z]` points in world metres) is a vertical **prism** over that polygon instead, spanning the same `center[1] +/- size[1]/2`:

```json
{ "id": "z-1", "name": "Takt A", "center": [0, 1.5, 0], "size": [0, 3, 0], "rotationY": 0,
  "footprint": [[0, 0], [12, 0], [12, 5], [4, 9]] }
```

- The polygon must be **convex**; a concave one is rejected on import, because the sweep, the point test and the overlap test are each silently wrong for it rather than visibly broken.
- `center` / `size` in X/Z and `rotationY` are **derived** from the footprint on import, so every bounds consumer keeps working. The vertical extent stays yours to edit; the 3D handles stay off, since dragging a derived bounding box would change nothing.
- Classification, apportionment and geometry splitting all follow the polygon. Apportionment costs a few times a box zone (one trapezoidal strip per footprint vertex pair), not a different order.

### Zone assignment write-back

The Zones panel writes a zone set's assignment onto the elements, so it survives an export instead of staying viewer state (issue #2508). Per element in the set:

| Set | Name | Carries |
|---|---|---|
| Property set | `IfcLite_Zones [<set name>]` | `ZoneSet`, `Zone` (the home zone, empty when the centroid is in no zone), `Zones` (every touched zone, joined with `", "`), `Straddles`, and the basis labels |
| Quantity set | `IfcLite_ZoneVolumes [<set name>] (<basis>)` | one `IfcQuantityVolume` per zone the element reaches, plus `Outside zones` when part of it is in none |

Neither name uses the `Pset_` / `Qto_` prefix, which buildingSMART reserves for its own published definitions.

Four things are deliberate:

- **The basis is chosen, and it is in the name.** `mesh` is the as-built geometry; `net` / `gross` / `unqualified` apportion the file's own declared quantity by the measured fractions, so a `net` breakdown sums to the declared `NetVolume` by construction. Elements that declare nothing on the chosen basis are refused rather than quietly falling back to the mesh.
- **Values are written in the model's declared volume unit**, converted per model, so a federated file in cubic millimetres and one in cubic metres both come out right.
- **A refusal is written down.** An element whose mesh is not a proven closed solid gets its zone names plus a `VolumeUnavailable` sentence, and no quantities. A missing row would read as zero.
- **The run does not enter the undo stack** - it writes to the overlay directly, because driving the per-mutation actions once per element is quadratic in the undo stack. Its inverse is the panel's own remove button, which clears the property set and the quantity set on every basis.

### Selection context menu

Right-click on an entity in 3D or the hierarchy:

| Item | Effect |
|---|---|
| **Delete entity** (red) | Tombstones the entity. Visible only when the active model has an editable mutation view. Toast confirms with undo hint. |
| **Add Column here…** (emerald) | Visible only when the right-clicked entity is an `IfcBuildingStorey`. Opens the Add Column dialog with the storey pre-filled. |

### Add Column dialog

A modal triggered from the context menu or the "Column" button on the Edit Toolbar (when a storey is selected):

  - **Storey picker** — sorted by elevation (bottom to top, matching the building) with each storey's elevation shown in metres.
  - **Position** — storey-local X / Y / Z in metres.
  - **Cross-section** — Width / Depth / Height with `> 0` validation per field.
  - **Name** — defaults to `Column`.
  - **Optional metadata** — Description / ObjectType / Tag, collapsed by default.

On submit, the dialog calls `bim.store.addColumn`, selects the newly-added column in the 3D scene, and shows a success toast. Anchor-resolution failures (e.g. a model without an `IfcOwnerHistory`) surface as an inline red alert inside the dialog rather than throwing.

### Mutation State

| State | Description |
|-------|-------------|
| Modified entities | Count of entities with property changes |
| Dirty models | Models with unsaved mutations |
| Undo stack | Per-model undo history (covers properties, whole property and quantity sets, quantities, attributes, positional args, entity create/delete) |
| Redo stack | Per-model redo history |
| Change sets | Named groups of mutations for export |
| Store editors | Per-model `StoreEditor` cache (created lazily on first store-level edit) |

## Store-Level Editing

The mutation overlay also supports **STEP-level edits** — adding new entities, deleting existing ones, and overriding positional STEP arguments on entities that don't have named attributes (e.g. `IfcRectangleProfileDef.XDim`). This is the API surface behind the viewer's Raw STEP tab and the `bim.store.*` SDK / sandbox namespace.

Use the property/quantity APIs above for IfcRoot edits (Name, FireRating, …). Reach for `StoreEditor` when you need to edit a profile dimension, drop a new column into an existing model, or remove a stale entity.

### StoreEditor — high-level API

```typescript
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

const view = new MutablePropertyView(propertyTable, modelId);
const editor = new StoreEditor(dataStore, view);

// Add a fresh entity with positional STEP attributes.
// Pass the canonical IFC EXPRESS PascalCase name; the public API surface
// (StoreEditor / bim.store) is consistently PascalCase. Internally,
// StepExporter upper-cases at the STEP write boundary.
const profile = editor.addEntity('IfcRectangleProfileDef', [
  '.AREA.', null, '#34', 0.6, 0.4,
]);
// → { expressId: <new>, type: 'IfcRectangleProfileDef', byteOffset: -1, ... }

// Override a single positional argument on an existing entity by index.
// (STEP argument index is zero-based — index 0 = first STEP argument.)
editor.setPositionalAttribute(profile.expressId, 3, 0.7);  // XDim → 0.7

// Remove an entity (existing entities are tombstoned, overlay-only ones forgotten).
editor.removeEntity(unwantedExpressId);
```

Edits accumulate in the same overlay used by `setProperty` / `setAttribute`. They land in the exported file the next time you call `exportToStep(store, { applyMutations: true })` from `@ifc-lite/export`.

### Atomic overlay edits

Use `StoreEditor.runAtomic` to create or modify a related set of IFC entities together. The callback receives a detached editor; a thrown error leaves the live overlay, mutation history and express-ID allocator unchanged. `MutablePropertyView.runAtomic` provides the same operation with a draft view for property and quantity edits.

```typescript
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

const view = new MutablePropertyView(propertyTable, modelId);
const editor = new StoreEditor(dataStore, view);
const colour = editor.runAtomic(draft => {
  const entity = draft.addEntity('IfcColourRgb', [null, 0.2, 0.4, 0.8]);
  if (!draft.hasEntity(entity.expressId)) throw new Error('Missing created colour');
  return entity;
});
console.log(editor.hasEntity(colour.expressId)); // true after publication
```

`hasEntity` recognizes live source, deferred-index and newly created entities, and rejects removed entities and invalid IDs. Atomic callbacks must be synchronous: prepare images, network requests and other asynchronous resources beforehand. Source tables and extractors remain shared read-only. Escaped draft editors and nested values cannot modify the published overlay. Reentering the original view is detected and preserves that independent edit rather than overwriting it.

Use `editor.getMutationView()` when an in-store read must include the same live overlay that the editor writes to. For example, space generation passes it to `resolveSpatialAnchor` so deleted or replaced storey placements cannot be reused.

For commands coordinating IFC with another synchronous subsystem, `view.prepareAtomic(callback)` returns `{ result, validate, commit, rollback }`. Preparation runs the callback without publishing. Validate all external resources before calling `commit`; it rejects intervening overlay edits, including edits that skip history. Repeated successful commits are harmless and never replay an old snapshot over newer edits. After a successful commit, `rollback` restores the original overlay, history and allocator only if no subsequent edit occurred; otherwise it throws and preserves those newer edits. Repeated rollback is harmless, and a rolled-back transaction cannot be committed again. Rollback before commit is a no-op.

These transactions publish IFC overlay state only. They do not group application undo stacks or roll back renderer, file or network effects. The caller must coordinate those effects and handle rollback refusal explicitly. Preparation copies the existing overlay and checks it for changes, so batch related edits in one transaction rather than opening a transaction for every entity.

### Cooperative owned entity operations

`StoreEditor.prepareEntityOperations` prepares a bounded list of `create`,
`setPositionalAttribute` and `remove` operations cooperatively. It is intended for
appearance authoring's staged IFC/history publication. It does not accept an async
callback and never exposes its mutable working view. The existing `runAtomic` and
`prepareAtomic` behavior is unchanged.

```typescript
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

const view = new MutablePropertyView(propertyTable, modelId);
const editor = new StoreEditor(dataStore, view); // establishes allocator watermark
const abort = new AbortController();
const operations = [{
  kind: 'create' as const,
  expressId: view.peekNextExpressId(),
  type: 'IfcTextureVertexList',
  attributes: [[[0, 0], [1, 0], [0, 1]]],
}];
const prepared = await editor.prepareEntityOperations(operations, { signal: abort.signal });
try {
  prepared.validate(); // coordinate other already-prepared resources here
  prepared.commit();
  console.log(prepared.effects, prepared.mutations);
} finally {
  prepared.dispose(); // release private checkpoints; does not undo a commit
}
```

Construction initializes the live allocator before preparation starts; cancellation
never advances it. Creation IDs must match the next sequential allocation. The
operation executor uses the same `StoreEditor` rules as ordinary edits. A missing
removal or invalid target discards the whole unpublished operation list.

Copies yield inside large nested attribute arrays. The default scheduler yields to
a host task, targeting four milliseconds per slice; `yieldTask` permits a host
scheduler override. A microtask-only scheduler does not let browser rendering run.
The defaults cap cumulative traversal at 16 million entries and conservatively
account 512 MiB across the owned copies; these are work/allocation estimates, not
measured heap use. `maxWork`, `maxBytes`, and `maxSliceMs` customize finite positive
budgets. Budget failures and unsupported values reject without publication.

The supported overlay vocabulary is strings, numbers, booleans, null and undefined (preserving negative
zero), plain objects, sparse arrays, maps with primitive keys, and sets
with primitive members. Aliases and cycles are preserved. Host objects, accessors,
functions and mutable map keys/set members are rejected on this opt-in path rather
than silently converted. Synchronous transaction support remains unchanged.

The handle's effects/history records are separate owned copies: caller edits
cannot modify the live publication or rollback checkpoint. Keep the input operation
list stable until commit. Exact synchronous comparisons reject changes to its owned
checkpoint or the captured live overlay, including skip-history/escaped nested SDK
edits. A changed source-index identity or size also rejects publication. Source
index records must otherwise follow their existing immutable-source contract.

Capture itself is cooperative, so it is not an instantaneous snapshot at method
entry. The final fence accepts only a coherent captured input equal to the live
input at publication. Callers whose operations depend on an earlier model revision
(such as a worker's appearance plan) must also retain and validate that earlier
source checkpoint. Neither a revision counter alone nor a yielded comparison can
replace the exact final fence. Its worst-case synchronous cost is linear in the
mutable input/overlay size; this API does not promise a universal frame budget.

Abort rejects preparation, including a pending scheduler wait, and abort after
preparation prevents commit. Commit is idempotent. Rollback restores the captured
original only while the published state still matches its private checkpoint;
newer SDK edits are preserved and cause rollback to throw. Dispose is idempotent;
before commit it abandons work, after commit it relinquishes rollback. No GPU,
image, network or application undo resources are implicitly published by this API.

#### STEP value conventions

`addEntity` and `setPositionalAttribute` accept the same value shape that `EntityExtractor.extractEntity().attributes` produces — keeping the read/write round-trip predictable:

| JS value | STEP literal |
|---|---|
| `null` / `undefined` | `$` |
| `42` / `0.6` | integer / REAL |
| `true` / `false` | `.T.` / `.F.` |
| `"#42"` (string) | entity reference |
| `".AREA."` (string) | enum |
| `"My Column"` (string) | quoted STEP string |
| `[1, 2, 3]` | STEP list `(1,2,3)` — recursive |

### High-Level Builders — `addColumnToStore` / `addWallToStore` / …

For full element-with-geometry inserts, `@ifc-lite/create` provides anchored builders that emit a complete sub-graph (placement, profile, extruded solid, representation, product shape, rel-contained-in-spatial-structure) into the overlay. The same builders back the viewer's Model workspace commands for these builder-supported elements and their corresponding SDK / sandbox `bim.store.*` methods.

| Builder | Signature highlights | Profile modes |
|---|---|---|
| `addColumnToStore` | `Position`, `Width × Depth × Height` | rectangle |
| `addWallToStore` | `Start`, `End`, `Thickness`, `Height` (planar XY axis enforced) | linear |
| `addBeamToStore` | `Start`, `End`, `Width × Height` cross-section | linear |
| `addMemberToStore` | `Start`, `End`, `Width × Height`, `PredefinedType` | linear |
| `addSlabToStore` | `Position` + `Width × Depth × Thickness` **or** `OuterCurve` polygon | rectangle / polygon |
| `addRoofToStore` | same shape as slab; emits `.FLAT_ROOF.` PredefinedType | rectangle / polygon |
| `addPlateToStore` | same shape as slab — thin extruded plate | rectangle / polygon |
| `addSpaceToStore` | rectangle or polygon footprint, extruded by `Height`. Aggregated to its storey via `IfcRelAggregates` | rectangle / polygon |
| `addDoorToStore` | `Position`, `Width × Height`, optional `OperationType` + `UserDefinedOperationType` | n/a |
| `addWindowToStore` | `Position`, `Width × Height`, optional `PartitioningType` + `UserDefinedPartitioningType` | n/a |

```typescript
import { StoreEditor } from '@ifc-lite/mutations';
import { addColumnToStore, resolveSpatialAnchor } from '@ifc-lite/create';

const editor = new StoreEditor(dataStore, view);
const anchor = resolveSpatialAnchor(dataStore, storeyExpressId, view);
//   ↳ reads live IfcOwnerHistory, representation context and storey placement,
//     including overlay-created records and excluding tombstones.

const result = addColumnToStore(editor, anchor, {
  Position: [1, 1, 0],     // storey-local metres
  Width: 0.3,
  Depth: 0.4,
  Height: 3,
  Name: 'Column 1',
});
// → { columnId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId }
```

The column lands in the existing spatial hierarchy, references the model's own owner history and 'Body' subcontext, and exports as a set of new STEP entities the next time you call `exportToStep(store, { applyMutations: true })` from `@ifc-lite/export`. No script + re-parse round-trip needed.

#### IFC4 vs IFC2X3

Builders read the schema from the resolved anchor (`anchor.schema`) and drop attribute-tail slots that don't exist in IFC2X3. For example `IfcWall.PredefinedType` and `IfcDoor.OperationType` are emitted on IFC4 only; on IFC2X3 the corresponding STEP records are 8 / 10 attributes wide. `USERDEFINED` enums round-trip through their companion `User-defined…` slot, so a custom `OperationType: 'USERDEFINED'` + `UserDefinedOperationType: 'Sliding-Curve'` exports as `.USERDEFINED.,'Sliding-Curve'`.

#### Straight stair dimensions

`readStairDimensions(dataStore, stairOrFlightExpressId, view?)` reads one canonical straight stepped flight in IFC2X3, IFC4 or IFC4X3, whether the selected occurrence is its `IfcStair` parent or its `IfcStairFlight`. It returns `Width`, `RiserHeight`, `TreadLength`, optional `WaistThickness` in metres and the held `NumberOfRisers`. The source reader uses the schema's native attribute names, including IFC2X3's `NumberOfRiser`. Mapped bodies, different profiles, additional representations, multiple flights and unreadable local frames return null. Profile inspection is bounded to at most 10,000 points.

`editStairDimensionsInStore(dataStore, editor, stairOrFlightExpressId, patch)` accepts the four length fields. It rebuilds only that flight's occurrence body through the same geometry emitter and validation as creation. The first-riser foot, placements, riser/tread counts, identities, type relationships and shared source/style leaves stay fixed. Changing riser height changes the total rise; changing tread length changes the total run. It does not refit the stair to the upper storey. Omitted fields keep their existing values; waist thickness can be added to a solid-to-base flight. Unsupported bodies, invalid dimensions and late unreadable styles refuse atomically without writes. The Model inspector exposes these edits for the actual selected flight and its parent, each as one Undo step and one remesh of the stair and flight.

[Native viewer evidence](../architecture/evidence/6232-stair-inspector/README.md) records the four dimension edits, each Undo and Redo, and the unchanged neighboring wall and windows.

#### Openings and hosted doors / windows

`addHostedElementInStore(dataStore, editor, hostExpressId, spec)` is the shared params-to-commit operation for viewer, SDK and MCP hosted placement. It resolves the live host, validates a wall cut's fit and overlap with existing openings, and writes the whole graph atomically. Dimensions are metres. Source and overlay openings both count; edge-touching cuts and vertically separate cuts are allowed. Unreadable bounds or placements are refused. `readHostOpeningExtents(dataStore, hostExpressId, view)` returns readable cuts with native-unit bounds in the host frame and an `unreadable` list. It supports mapped bodies, including nested transforms; placements must be relative to the host. Bounds are conservative for boolean bodies.

The lower-level `addOpeningToStore` emits an `IfcOpeningElement` and `IfcRelVoidsElement` in an existing `IfcWall` or `IfcSlab`; `addHostedDoorToStore` / `addHostedWindowToStore` also emit the filling and `IfcRelFillsElement`. The host can come from the file or overlay. `resolveHostAnchor` reads its placement, containing storey and Body bounds. Use the shared operation when committing a wall placement so the fit/overlap rules apply.

```typescript
import { StoreEditor } from '@ifc-lite/mutations';
import { addHostedElementInStore } from '@ifc-lite/create';

const editor = new StoreEditor(dataStore, view);

// Wall-local metres: Offset along the wall axis to the centre, Sill above its base.
const door = addHostedElementInStore(dataStore, editor, wallExpressId, {
  kind: 'door', params: { Offset: 2.5, Width: 0.9, Height: 2.1 },
});
// → { expressId, openingId, hostId }

const hole = addHostedElementInStore(dataStore, editor, wallExpressId, {
  kind: 'opening', params: { Offset: 5, Sill: 1.8, Width: 0.4, Height: 0.4 },
});
```

The opening is placed relative to the host's own `IfcLocalPlacement` and is not contained in the storey (IFC reaches it through the element it voids). By default the cut runs through the host's body thickness plus 50 mm per face; pass `CutDepth` to override it, but never with a value thinner than the host. The door or window is placed relative to the opening, centred in the wall, and contained in the host's storey. For a slab host, pass `Position: [x, y]`, `Width` and `Depth` in the slab's local frame. Through the SDK these are `bim.store.addOpening`, `bim.store.addHostedDoor` and `bim.store.addHostedWindow` (`modelId, hostExpressId, params`). In the viewer they go through the same store action as the Model workspace's Opening, Door and Window tools: the whole graph is one undo step, and the host is re-meshed with its void. `readHostedFill(dataStore, id, mutationView)` reads an opening's (or its door's or window's) host, `Offset` along the wall and `Sill`, and `hostPlanFrame(dataStore, hostId, storeyId, mutationView)` the host wall's placement frame on its storey, both through the overlay. In the viewer, resizing a host through the Model workspace's Push / Pull handles or the inspector's Dimensions rows keeps its openings valid in the same undo step: a thicker wall (or slab) lengthens the cuts that no longer span it, and a wall height that would leave an opening above the wall is refused.

`readHostedElementSize(dataStore, expressId, view)` reads a door or window's `OverallWidth` and `OverallHeight` in metres. When its optional IFC attributes are omitted, the physical Model Body supplies the dimensions. `editHostedElementInStore` changes those dimensions or the hosted `Offset` / `Sill` atomically, using the same fit and overlap validation as placement. It accepts openings for position edits and doors/windows for position or size edits, with a wall host in IFC2X3, IFC4 or IFC4X3.

```typescript
import { editHostedElementInStore, readHostedElementSize } from '@ifc-lite/create';

const size = readHostedElementSize(dataStore, expressId, view);
if (size) {
  editHostedElementInStore(dataStore, editor, expressId, {
    OverallWidth: 1.2,
    OverallHeight: size.OverallHeight,
  });
}
```

Size edits apply an affine mapping to the selected occurrence and its opening, holding the existing cut's centre and bottom while preserving its thickness. Repeated size edits combine compatible existing scales so mapping depth does not grow with every commit. Source/type geometry, styles, metadata, relationships and other occurrences remain unchanged. Fresh placements prevent a move from altering shared source points. Size edits require a readable filling Body; position-only edits also support fillings whose optional Body is absent or cannot be measured. Both require readable opening bounds and valid placements, and refusals leave no writes. In the viewer, the Dimensions and Hosting fields and plan slide handle call this core; each successful edit is one undo step and re-meshes the filling and voided host through WASM.

`reanchorHostedOpeningsInStore(dataStore, editor, hostExpressId, shift)` preserves every hosted opening when a validated host edit translates its origin. `shift` is the origin displacement in the host frame, in native file units. The caller validates the final host body before resizing it. The operation gives each opening and filling fresh placement records, leaving shared source points and placements untouched. It reanchors the full batch atomically, without testing one cut against another cut's temporary position during the move. Unreadable cuts or placements refuse without writes. Trim/Extend uses this operation inside its existing one-step undo transaction.

`reassignHostedOpeningsInStore(dataStore, editor, sourceHostExpressId, moves)` applies a validated wall split plan to a batch of `{ openingId, hostId, location }` entries. Each native-unit `location` is relative to its target host. The operation preserves opening/filling/relationship identities, changes the void relation's host when needed, and gives each edited occurrence fresh placements. Duplicate entries, ambiguous source void relationships and unreadable placements refuse atomically. Wall split and multisplit use this same placement writer and include all new placement records in one undo step.

A curtain wall and a design grid have their own in-store builders. `addCurtainWallToStore(editor, anchor, params)` writes an `IfcCurtainWall` along a base line that aggregates its `IfcMember` mullions and transoms and its `IfcPlate` panels (`curtainWallLayout(params)` returns the same layout without emitting anything). `addGridToStore(editor, anchor, params)` writes an `IfcGrid` with tagged `IfcGridAxis` curves (`rectangularGridAxes` makes the numbered and lettered orthogonal axes). The viewer's Curtain Wall and Grid tools commit each as one undo step. `extractGridAxesForStorey(dataStore, storeyId, overlay)` reads back the grid axes that apply to a storey, from the file and from grids authored this session, as segments in storey-local metres; the Model workspace's snapping uses it, so walls, columns and curtain walls land on grid lines and grid intersections. Each segment carries the canonical `AxisTag`. Straight polylines can contain intermediate collinear points; bent polylines, unsupported curves and unreadable placement frames are counted in `skippedAxes` rather than offered as invented straight snap lines. Omitted optional placement directions keep the IFC defaults; explicit unresolved, zero or incomplete direction vectors on required placement hops are refused through the same canonical placement reader used for hosted geometry. Shared ancestor frames cancel when converting to storey-local coordinates, so an unreadable ancestor does not prevent extraction when neither side needs its transform. Trimmed line axes require a readable 2D `IfcLine` basis with a typed `IfcVector`, a nonzero `IfcDirection` and finite positive `Magnitude`, including when trimmed by points. Unreadable bases and nonfinite endpoints are counted in `skippedAxes`. A grid without `ObjectPlacement` uses identity only when its readable storey also omits `ObjectPlacement`; otherwise its axes are counted in `skippedAxes`.

The Model workspace's plan pane draws the active storey's design-grid axes and exact `AxisTag` bubbles, including grids authored during the session and grids read from an exported file. Fit includes the axes and reserves room for normal-sized label bubbles, so a grid beyond the building's outline can be framed. Oversized labels may clip; their margin cannot invert the view or pointer transform. Grid edits, Undo and Redo update the drawing. Grid type visibility, embedding-host `IfcGridAxis` hides, model visibility and model-qualified grid or axis entity hides apply to the plan drawing.

#### Joining existing walls

`joinWallsInStore(editor, dataStore, resolveWallJoinAnchor(dataStore, view), aId, bId, options)` joins straight walls in the same placement frame. It atomically rewrites bodies and axes and creates `IfcRelConnectsPathElements`, replacing an existing relationship for the same pair. Readable hosted openings keep their placement; a cut outside either joined end face, or unreadable opening geometry, refuses the whole operation. IFC2X3, IFC4 and IFC4X3 use their own relationship layouts. Existing geometric options remain `WallJoinApplyOptions`.

The SDK and sandbox expose `bim.store.joinWalls(modelId, aExpressId, bExpressId, options?)`; MCP exposes `join_walls`. The viewer remeshes both walls and records one undo. MCP's compound recording restores earlier profiles, axes, positional references and replaced relationships in one `mutation_undo`, including records created earlier in the session.

`recordCompoundMutation(view, draft => ...)` and `undoRecordedMutationOperations(view, count, revertRaw)` from `@ifc-lite/mutations` provide this shared compound history. Write through the supplied draft; the undo dispatcher handles unrecorded journal entries through `revertRaw`. Each compound is one operation, and a failed inverse publishes no partial undo. Retained inverses contain changed overlay entries and removed journal records, without a copy of each unchanged graph or journal prefix. Both callbacks must be synchronous. The journal and earlier overlay graph are restored together; allocated express IDs remain monotonic.

#### Type objects and materials

`addElementTypeToStore` writes any `IfcElementType` subtype (`IfcWallType`, `IfcSlabType`, `IfcDoorType`, `IfcWindowType`, ...). Its attribute layout comes from the model's schema: IFC2X3 has no `IfcDoorType`, and IFC4 adds `OperationType`, so the same call writes a valid record in each schema or refuses the class by name. Enumeration values are checked against the schema. `assignTypeInStore` links occurrences through `IfcRelDefinesByType`. It extends the type's existing relationship, and it moves an occurrence off any other type, because an occurrence has one type.

Materials follow the IFC4 practice for layered elements. The `IfcMaterialLayerSet` goes on the type, and an `IfcMaterialLayerSetUsage` of that set goes on each occurrence to say where the layers sit relative to its reference line: `AXIS2` across a wall, `AXIS3` up through a slab. `assignMaterialInStore` associates any `IfcMaterialSelect` (a plain `IfcMaterial` too) through `IfcRelAssociatesMaterial`, and it replaces an object's previous association.

```typescript
import { StoreEditor } from '@ifc-lite/mutations';
import {
  addElementTypeToStore, addMaterialLayerSetToStore, addMaterialLayerSetUsageToStore, addMaterialToStore,
  assignMaterialInStore, assignTypeInStore, readRelatedLists, resolveAuthoringAnchor,
} from '@ifc-lite/create';

const editor = new StoreEditor(dataStore, view);
const anchor = resolveAuthoringAnchor(dataStore, view);

const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'EW-300', PredefinedType: 'SOLIDWALL' });
assignTypeInStore(editor, anchor, typeId, [wallExpressId], readRelatedLists(dataStore, 'IfcRelDefinesByType', view));

const concrete = addMaterialToStore(editor, anchor, { Name: 'Concrete', Category: 'concrete' }).materialId;
const wool = addMaterialToStore(editor, anchor, { Name: 'Mineral wool', Category: 'insulation' }).materialId;
const { layerSetId } = addMaterialLayerSetToStore(editor, anchor, {
  LayerSetName: 'EW-300',
  MaterialLayers: [{ Material: concrete, LayerThickness: 0.2 }, { Material: wool, LayerThickness: 0.1 }],
});
// A wall centred on its axis: the layers start half its thickness below the reference line.
const { usageId } = addMaterialLayerSetUsageToStore(editor, anchor, { ForLayerSet: layerSetId, OffsetFromReferenceLine: -0.15 });

const associations = () => readRelatedLists(dataStore, 'IfcRelAssociatesMaterial', view);
assignMaterialInStore(editor, anchor, layerSetId, [typeId], associations());
assignMaterialInStore(editor, anchor, usageId, [wallExpressId], associations());
```

Layer thicknesses and offsets are metres, converted to the file's length unit. Through the SDK these are `bim.store.addElementType`, `assignType`, `addMaterial`, `addMaterialLayerSet`, `addMaterialLayerSetUsage` and `assignMaterial`. The two `assign*` methods read the model's existing relationships themselves.

#### Generate spaces — IfcSpace from a storey's walls

For room generation, `@ifc-lite/create` ships a planar-graph face finder that turns a storey's wall axes into a CCW polygon per enclosed region:

```typescript
import { generateSpacesFromWalls } from '@ifc-lite/create';

const result = generateSpacesFromWalls(editor, dataStore, storeyExpressId, {
  snapTolerance: 0.05,    // collapse sloppy wall ends within 5 cm
  minArea: 0.5,           // drop closets / slivers
  height: 3,              // IfcSpace extrusion in m
  namePattern: 'Space {n}',
  predefinedType: 'INTERNAL',
  // dryRun: true,        // detect-only — no IfcSpace emitted
});
// → { wallsConsidered, wallsContributing, detected: DetectedSpace[], emitted: [...] }
```

The detector also picks up overlay walls (placed via `addWallToStore` since the model was parsed) when you pass an `OverlayWallReader` — the viewer's Room tool (**Auto**) does the same for freshly-drawn walls without a re-parse. `detectEnclosedAreas(segments, options)` is exported as the pure pipeline step if you want detection without IFC emission.

In the viewer, **Room → More** keeps the minimum area, name pattern, and schema-specific space classification alongside read-only candidate totals. `addSpaceToStore` validates the classification before writing: IFC2X3 uses `InteriorOrExteriorSpace`, IFC4 and IFC4X3 use `PredefinedType`, and `USERDEFINED` needs an `ObjectType`. An `EXTERNAL` space sets `Pset_SpaceCommon.IsExternal` to true.

### `bim.store.*` — Scripting & SDK

The viewer's QuickJS sandbox and the TypeScript SDK expose the core mutation surface as `bim.store`:

```typescript
// SDK (TypeScript app)
const profile = bim.store.addEntity('default', {
  type: 'IfcRectangleProfileDef',
  attributes: ['.AREA.', null, '#34', 0.6, 0.4],
});
bim.store.setPositionalAttribute(profile, 3, 0.7);
bim.store.removeEntity(unwantedRef);

// High-level builder
const storey = bim.query().byType('IfcBuildingStorey').refs()[0].expressId;
const col = bim.store.addColumn('default', storey, {
  Position: [1, 1, 0],
  Width: 0.3, Depth: 0.4, Height: 3,
  Name: 'Column 1',
});
```

**Which `modelId`?** The headless backend behind `ifc-lite run` and `ifc-lite eval` holds exactly one model and answers for two spellings of it: `'default'` and the file's basename (`'tower.ifc'`). Any other id throws at the create call, rather than handing back a ref that the next `bim.mutate.*` write would refuse. Use the id you were given: the refs from `bim.query()` already carry it, and in the viewer it is the real model id from the model registry.

The sandbox gates `bim.store.*` behind a `store: true` permission (default `false`, mirrors the existing `mutate` permission). The viewer opts in.

**Cost / 5D authoring (#4857)** — `addCostSchedule`, `addCostItem`, `addCostValue`, `addCostQuantity`, `nestCostItems`, `assignCostItemsToSchedule`, `assignToCostItem`, `setCostItemValues`, `removeCostEntity` — is available through the CLI/headless and viewer SDK adapters and is registered in the viewer's QuickJS `bim.store` bridge (subject to the existing `store` permission). The viewer's cost panel stays read-only by design (see [Cost Panel → Authoring from scripts](cost-panel.md#authoring-from-scripts)). An authored `IfcCostItem`/`IfcCostValue` is visible to `bim.cost.data()` immediately, before export.

### Viewer UI

The viewer surfaces store-level edits through the following controls — see [Viewer Integration](#viewer-integration) above for the full UX:

  - **Raw STEP tab** in the properties panel — inline pen-icon editor on every positional argument. Edited rows show a purple dot; the editor parses the same STEP literal conventions as `setPositionalAttribute`. The tab also opens for overlay-only entities (freshly added or duplicated) so newly-created walls / columns / spaces are immediately inspectable, even before export.
  - **Right-click → Delete entity** — calls `removeEntity`, surfaces a toast with undo support.
  - **Right-click on a storey → Add Column here…** — opens the Add Column dialog, calls `addColumn` on submit, and selects the new column in the 3D scene.
  - **Model workspace** (Author ribbon → Model, or `E`). A tool rail with one command per kind: Wall, Slab (also roof and plate), Column, Beam (also member), Room, Opening, Door, Window, Stair, Railing, Curtain wall, Grid; plus Split, Move, Rotate, Copy / Array and the inspector's type, material and size fields. Storey-workplane placement tools use snapping, a live ghost and typed bar values. Hosted Door/Window tools are wall-relative. Split, Move, Rotate, Copy / Array and inspector edits use their own interaction flows. The **Room** command's **Auto** runs the wall-graph face finder on the storey (or every storey), and its Edit, Footprint and leak-check modes reshape the rooms.

All paths route through the same `mutationSlice` actions that wrap `StoreEditor`, so undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`) covers store-level edits identically to property edits. Each commit also injects a renderer-frame mesh into the geometry pipeline so the new element appears in 3D the moment the action fires — no export+reparse round-trip required.

### When to use what

| You want to… | Use |
|---|---|
| Edit an IfcRoot named attribute (Name, FireRating, ObjectType, …) | `setProperty` / `setAttribute` (see above) |
| Edit a positional STEP arg on a non-IfcRoot entity (profile dim, cartesian point, …) | `setPositionalAttribute` / `bim.store.setPositionalAttribute` |
| Inject a small raw STEP entity (a point, a profile, a unit) | `addEntity` / `bim.store.addEntity` |
| Drop a fully-formed building element with geometry | `addColumnToStore` / `addWallToStore` / `addSlabToStore` / `addBeamToStore` / `addDoorToStore` / `addWindowToStore` / `addSpaceToStore` / `addRoofToStore` / `addPlateToStore` / `addMemberToStore` (or `bim.store.add{Column,Wall,Slab,…}`) |
| Cut an opening, or put a door / window into an existing wall | `addOpeningToStore` / `addHostedDoorToStore` / `addHostedWindowToStore` (or `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow`) |
| Add a type object, or a material / layer set / layer set usage, and assign it | `addElementTypeToStore` + `assignTypeInStore`, `addMaterial*ToStore` + `assignMaterialInStore` (or `bim.store.addElementType` / `assignType` / `addMaterial*` / `assignMaterial`) |
| Generate IfcSpace volumes from a storey's existing walls | `generateSpacesFromWalls` (or **Model → Room → Auto** in the viewer) |
| Duplicate an element with its hosted openings, fillings and assembly parts | right-click → Duplicate / Ctrl+D (the same `copyProductInStore` write as Paste and Array) |
| Copy an element turned, moved or onto another storey, with fresh GlobalIds and the openings, doors, windows and assembly parts in it | `createCopyContext` + `copyProductInStore` / Model workspace → Copy, Paste, Array |
| Remove an entity from an existing model | `removeEntity` / `bim.store.removeEntity` |
| Build a brand-new IFC file from scratch | `IfcCreator` (see [API Reference](../api/typescript.md#ifc-litecreate)) |

`copyProductInStore` returns `copiedFrom`, a map from each new product id to its source id, including openings, fillings and assembly parts. Its optional fourth argument, `{ Name }`, overrides the root product’s Name and preserves its parts’ names. The map lets consumers mirror source geometry and property reads without reconstructing the copied relationships. The viewer records the complete copied subgraph as one undo step and re-meshes the copies through wasm. A part or hosted filling cannot be copied alone, and a placement disconnected from its storey is refused.

## Key Types

| Type | Description |
|------|-------------|
| `MutablePropertyView` | Wraps property table with mutation overlay (properties, quantities, attributes, positional args, new entities, tombstones) |
| `StoreEditor` | High-level facade for store-level edits — `addEntity`, `removeEntity`, `setPositionalAttribute` |
| `Mutation` | A single change with old/new values. `type` is one of `UPDATE_PROPERTY`, `UPDATE_QUANTITY`, `UPDATE_ATTRIBUTE`, `UPDATE_POSITIONAL_ATTRIBUTE`, `CREATE_ENTITY`, `DELETE_ENTITY`, … |
| `ChangeSet` | Named collection of mutations |
| `ChangeSetManager` | Manages multiple change sets |
| `BulkQueryEngine` | Query and update entities in bulk |
| `CsvConnector` | Import property data from CSV files |
| `addColumnToStore` | High-level anchored IfcColumn builder (`@ifc-lite/create`) |
| `resolveSpatialAnchor` | Reads owner history, root/body/axis representation contexts, and storey placement from the parsed store plus an optional live mutation view (`@ifc-lite/create`); `rootContextId` is null when no root context exists |

## Previewing wall endpoint edits

`reshapeWallAxis` from `@ifc-lite/create` calculates the wall on its new plan axis before a join recuts the changed end. It retains a supported cut at an unchanged endpoint when the axis direction stays the same, including cuts read from a four-point profile without a join relationship. A cut is measured from its own endpoint: extending Start does not shift EndCut. A changed endpoint or axis direction starts square.

The canonical `reshapeWallsInStore` writer uses this calculation too. Trim/Extend uses it for the ghost, so an unchanged joined or custom-cut face matches the body that is committed. Existing joins are then recomputed by the writer; callers group those writes in their atomic undo transaction.

```typescript
import { reshapeWallAxis, wallBodyOutline, type WallJoinWall } from '@ifc-lite/create';

const wall: WallJoinWall = {
  start: [0, 0], end: [4, 0], thickness: 0.2,
  startCut: { left: -0.1, right: -0.25 },
};
const extended = reshapeWallAxis(wall, [0, 0], [6, 0]);
const body = wallBodyOutline(extended); // The original start face is retained.
```
