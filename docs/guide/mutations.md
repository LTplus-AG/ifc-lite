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

For updating many entities at once, use the `BulkQueryEngine`:

```typescript
import { BulkQueryEngine } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

// Constructor requires EntityTable and MutablePropertyView
const engine = new BulkQueryEngine(entityTable, mutationView);

// Define a bulk query - which entities to update and how
const query = {
  select: {
    entityTypes: [10],    // Type enum values (e.g., IfcWall)
    propertyFilters: [{
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      operator: '=' as const,
      value: true,
    }],
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
```

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
```

## Viewer Integration

In the IFClite viewer:

1. **Select an entity** in 3D or the hierarchy panel
2. **Open Properties panel** — Edit properties directly in the panel
3. **Bulk edit** — Use the Property Editor to update multiple entities
4. **Track changes** — Modified properties are highlighted
5. **Undo/Redo** — Ctrl+Z / Ctrl+Shift+Z to undo/redo edits
6. **Export** — Save modified IFC with changes applied

### Properties panel tabs

| Tab | Edits | Backed by |
|---|---|---|
| **Properties** | IfcRoot named attributes (Name, Description, …), property sets, classifications, materials, documents | `setProperty` / `setAttribute` |
| **Quantities** | Quantity sets and individual quantities | `setQuantity` |
| **bSDD** | Add buildingSMART Data Dictionary properties | `setProperty` |
| **Raw STEP** | Positional STEP arguments on the selected entity (one row per arg, inline pen-icon editor). Mutated rows show a purple dot. | `setPositionalAttribute` |

The Raw STEP tab is the right place for non-IfcRoot edits — `IfcRectangleProfileDef.XDim`, `IfcCartesianPoint.Coordinates`, anything without a symbolic attribute name.

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
| Undo stack | Per-model undo history (covers properties, quantities, attributes, positional args, entity create/delete) |
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

Edits accumulate in the same overlay used by `setProperty` / `setAttribute`. They land in the exported file the next time you call `StepExporter.export({ applyMutations: true })`.

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

For full element-with-geometry inserts, `@ifc-lite/create` provides anchored builders that emit a complete sub-graph (placement, profile, extruded solid, representation, product shape, rel-contained-in-spatial-structure) into the overlay. The same builder backs every Add Element panel chip in the viewer — and the SDK / sandbox `bim.store.*` namespace.

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
const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
//   ↳ walks the parsed store for IfcOwnerHistory, the 'Body' representation
//     context, and the storey's IfcLocalPlacement.

const result = addColumnToStore(editor, anchor, {
  Position: [1, 1, 0],     // storey-local metres
  Width: 0.3,
  Depth: 0.4,
  Height: 3,
  Name: 'Column 1',
});
// → { columnId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId }
```

The column lands in the existing spatial hierarchy, references the model's own owner history and 'Body' subcontext, and exports as a set of new STEP entities the next time you call `StepExporter.export({ applyMutations: true })`. No script + re-parse round-trip needed.

#### IFC4 vs IFC2X3

Builders read the schema from the resolved anchor (`anchor.schema`) and drop attribute-tail slots that don't exist in IFC2X3. For example `IfcWall.PredefinedType` and `IfcDoor.OperationType` are emitted on IFC4 only; on IFC2X3 the corresponding STEP records are 8 / 10 attributes wide. `USERDEFINED` enums round-trip through their companion `User-defined…` slot, so a custom `OperationType: 'USERDEFINED'` + `UserDefinedOperationType: 'Sliding-Curve'` exports as `.USERDEFINED.,'Sliding-Curve'`.

#### Auto Spaces — generate IfcSpace from a storey's walls

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

The detector also picks up overlay walls (placed via `addWallToStore` since the model was parsed) when you pass an `OverlayWallReader` — the viewer wires this in automatically so the Auto Spaces button works on freshly-drawn walls without a re-parse. `detectEnclosedAreas(segments, options)` is exported as the pure pipeline step if you want detection without IFC emission.

### `bim.store.*` — Scripting & SDK

In the viewer's QuickJS sandbox and the TypeScript SDK, the same surface is exposed as `bim.store`:

```typescript
// SDK (TypeScript app)
const profile = bim.store.addEntity('arch', {
  type: 'IfcRectangleProfileDef',
  attributes: ['.AREA.', null, '#34', 0.6, 0.4],
});
bim.store.setPositionalAttribute(profile, 3, 0.7);
bim.store.removeEntity(unwantedRef);

// High-level builder
const storey = bim.query.byType('IfcBuildingStorey')[0].ref.expressId;
const col = bim.store.addColumn('arch', storey, {
  Position: [1, 1, 0],
  Width: 0.3, Depth: 0.4, Height: 3,
  Name: 'Column 1',
});
```

The sandbox gates `bim.store.*` behind a `store: true` permission (default `false`, mirrors the existing `mutate` permission). The viewer opts in.

### Viewer UI

The viewer surfaces store-level edits in three places — see [Viewer Integration](#viewer-integration) below for the full UX:

  - **Raw STEP tab** in the properties panel — inline pen-icon editor on every positional argument. Edited rows show a purple dot; the editor parses the same STEP literal conventions as `setPositionalAttribute`. The tab also opens for overlay-only entities (freshly added or duplicated) so newly-created walls / columns / spaces are immediately inspectable, even before export.
  - **Right-click → Delete entity** — calls `removeEntity`, surfaces a toast with undo support.
  - **Right-click on a storey → Add Column here…** — opens the Add Column dialog, calls `addColumn` on submit, and selects the new column in the 3D scene.
  - **Add Element panel** (command palette → `Add element` or shortcut). Right-side panel with chips for every supported type, per-type form, click-to-place flow, and a 3D ghost preview that updates live as you adjust dimensions. Snap-to-vertex/edge/face is on by default (toggle with `S`); placements off-surface fall back to the storey floor plane so you can drop columns / walls into empty rooms. Picking the `Space` chip reveals an **Auto Spaces** sub-panel that runs the wall-graph face finder with adjustable snap tolerance / min area / height / naming pattern and a Preview button before commit.

All paths route through the same `mutationSlice` actions that wrap `StoreEditor`, so undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`) covers store-level edits identically to property edits. Each commit also injects a renderer-frame mesh into the geometry pipeline so the new element appears in 3D the moment the action fires — no export+reparse round-trip required.

### When to use what

| You want to… | Use |
|---|---|
| Edit an IfcRoot named attribute (Name, FireRating, ObjectType, …) | `setProperty` / `setAttribute` (see above) |
| Edit a positional STEP arg on a non-IfcRoot entity (profile dim, cartesian point, …) | `setPositionalAttribute` / `bim.store.setPositionalAttribute` |
| Inject a small raw STEP entity (a point, a profile, a unit) | `addEntity` / `bim.store.addEntity` |
| Drop a fully-formed building element with geometry | `addColumnToStore` / `addWallToStore` / `addSlabToStore` / `addBeamToStore` / `addDoorToStore` / `addWindowToStore` / `addSpaceToStore` / `addRoofToStore` / `addPlateToStore` / `addMemberToStore` (or `bim.store.add{Column,Wall,Slab,…}`) |
| Generate IfcSpace volumes from a storey's existing walls | `generateSpacesFromWalls` (or **Add Element → Space → Auto Spaces** in the viewer) |
| Duplicate any IfcRoot product (psets, qsets, materials, type associations preserved) | `duplicateInStore` / right-click → Duplicate |
| Remove an entity from an existing model | `removeEntity` / `bim.store.removeEntity` |
| Build a brand-new IFC file from scratch | `IfcCreator` (see [API Reference](../api/typescript.md#ifc-litecreate)) |

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
| `resolveSpatialAnchor` | Walks a parsed store for owner history, 'Body' context, and storey placement (`@ifc-lite/create`) |
