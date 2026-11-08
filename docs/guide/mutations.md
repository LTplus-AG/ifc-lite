# Property Editing

IFClite supports editing IFC properties in-place with full change tracking, undo/redo, and export. The `@ifc-lite/mutations` package provides the mutation infrastructure, while the viewer integrates it with a property editor UI.

Authored `NewEntity` records carry native `creationId` provenance matching the
original `CREATE_ENTITY` mutation UUID. It is not an IFC attribute. Preserve
the original record's token through clone, undo and recovery; a tokenless body
at a reused express ID cannot establish the identity of a captured entity from
old journal entries or matching fields.

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

Single-quantity edits record `oldQuantityType` and `oldUnit` alongside the old value, so Undo restores the previous quantity class and unit and Redo uses the recorded new metadata. `oldUnit: null` records a previously absent unit. Passing `null` as the unit to `setQuantity` explicitly clears a source unit; omitting it retains the existing source inheritance behavior. Quantity overlays and history use `unitRemoved: true` to distinguish an explicitly removed unit from an older overlay that inherits its source unit. Hosts can replay single-quantity edits through `replayQuantityMutation(view, mutation, 'undo' | 'redo', skipHistory)`; forward `view.applyMutations` uses the same metadata rules. Older history entries did not capture prior metadata: Undo restores their old value while retaining the currently effective class and unit, because a historical type change cannot be reconstructed. Write-only replay targets can omit the optional quantity reader; legacy forward records without a recorded type keep the existing Count fallback. Generated quantity export resolves supported unit names through the same existing unit resolver as properties; unresolved units remain `$`.

Whole-set edits (`createPropertySet`, `deletePropertySet`, `createQuantitySet`, `deleteQuantitySet`, `deleteQuantity`) record the set's overlay rows before and after the edit on the returned mutation's `setOverlay`. A host with its own undo history reverts or re-applies one of them with `view.restoreSetOverlay(mutation.setOverlay.before)` / `(...after)`, which is what the viewer does.

`view.getQuantityMutation(entityId, qsetName, quantityName)` reads the current quantity override, including `unitRemoved`, without relying on the append-only journal. It also reflects edits made with `skipHistory` and current Undo/Redo state. A reader preserving a source quantity’s explicit unit must withhold that unit once this override explicitly removes it.

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

### Reviewed table, bulk and IDS corrections

The Data Connector (CSV import), the Bulk Property Editor and the IDS correction dialog each have **Review as changes** as their primary action. It converts the configured edit into the reviewed change batch described in [Viewer Assistant: reviewed model changes](viewer-assistant.md#reviewed-model-changes): every change names its element by GlobalId, pins its model, and states the value the model holds now (including unsaved edits) as the expected value. Nothing is written until a batch is applied in the review, which happens as one undo step with a receipt. A value edited after the table or selection was read shows as **Value changed** and is never overwritten.

- **CSV rows** are keyed by a GlobalId, Tag or Name column. A row whose key is empty, repeats on another row, matches no element or matches several elements (a wall and its wall type often share a Name) is skipped and listed with its row number; a key is never guessed. Cells are parsed with the same rules as the direct import (`12,5` in a Real column is refused). Empty cells change nothing, and values already set are counted rather than proposed. Tag keys read each element's Tag and are refused above 200,000 elements.
- **Units**: a mapped column may declare a unit. The value is converted to SI and then to the frame the model stores: the property's own unit when it has one, otherwise the project unit (0.25 `m` is written as 250 in a millimetre model). A unit that does not fit the target (an area unit on a length quantity) is refused. Without a unit a number is taken to be in the model's stored units. Quantities are only updated where they already exist.
- **Bulk edits** become one change per target. Deleting a property that is absent, or setting a value that is already set, is counted rather than proposed. A whole number set as Real stays `IfcReal`.
- **Mappings** are checked before conversion: two columns writing the same value, or a property or quantity set without a name, refuse the review with a message instead of producing a partial batch.
- **IDS corrections** use the same value typing and base-SI-to-model-unit scaling as the direct correction, keep the IFC data type, and leave validation to the receipt's **Re-run validation**.

One batch holds at most 500 changes; a larger set is split into numbered parts (`… (part 2 of 3)`), each reviewed, applied and undone on its own. Parts never touch the same value. Above 20 parts (10,000 changes) the set is refused with a request to narrow the table or selection.

The direct paths remain as secondary buttons (**Import** and **Apply to N entities**): they stream large imports with progress, match rows by Express ID or by a property value, write one row to several matched elements, and handle sets above the review limit. They do not show expected values or produce a receipt.

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

An untouched draft reads the same model revision and overlay contents as its live view. Initializing an editor's express-ID watermark does not change that model revision; transaction validation checks the allocator separately so an intervening watermark change cannot be overwritten by publication.

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

`addOrdinaryElementInStore(editor, anchor, element)` dispatches wall, column, slab, beam, space, roof, plate and member creation through those builders in one atomic IFC edit. A late parameter refusal leaves the overlay, mutation journal and allocator unchanged. `element` uses the existing builder parameters with a lower-case `kind`; dimensions remain storey-local metres. Pass either a resolved `SpatialAnchor` or a synchronous `(draftEditor) => SpatialAnchor` callback. The latter lets a host prepare its existing placement policy inside the same transaction. External mesh, room and history effects run after it returns. The shared SDK factory `createOrdinaryStoreBackend(resolveModel)` supplies the existing eight `bim.store.add*` methods; it resolves the live store, editor and mutation view for each call without changing their anchor or null-placement defaults. MCP records each creation graph as one compound Undo operation, preserving earlier edits.

The viewer's **Start blank** action opens an empty IFC project with a storey, waits for its model registration, and enters Wall on that project. Cancelling or replacing the load prevents a late Wall launch on another model. Walls added there use the normal IFC geometry engine and support Undo and Redo. Primary IFC loads that produce no meshes retain the engine's coordinate information for subsequent edits and reserve their spatial entity ids for federation.

| Builder | Signature highlights | Profile modes |
|---|---|---|
| `addColumnToStore` | `Position`, `Height`, optional `RefDirection` | rectangle / parameterised `Profile` |
| `addWallToStore` | `Start`, `End`, `Thickness`, `Height` (planar XY axis enforced) | linear |
| `addBeamToStore` | `Start`, `End`, `Width × Height` or `Profile` | rectangle / parameterised `Profile` |
| `addMemberToStore` | `Start`, `End`, `Width × Height` or `Profile`, `PredefinedType` | rectangle / parameterised `Profile` |
| `addSlabToStore` | `Position` + `Width × Depth × Thickness` **or** `OuterCurve` polygon | rectangle / polygon |
| `addRoofToStore` | same shape as slab; emits `.FLAT_ROOF.` PredefinedType. With `EdgeSlopes` / `Overhang`, a roof by footprint (below) | rectangle / polygon |
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

`editStairDimensionsInStore(dataStore, editor, stairOrFlightExpressId, patch)` accepts the four length fields and `NumberOfRisers` (a whole number; the tread count follows it). It rebuilds only that flight's occurrence body through the same geometry emitter and validation as creation, and removes the replaced shape when nothing else uses it. The first-riser foot, placements, identities, type relationships and shared source/style leaves stay fixed. Changing riser height or the riser count changes the total rise; changing tread length changes the total run. The editor itself does not refit a stair to the storey above; a storey edit does, through this editor (see "Storey authoring"). Omitted fields keep their existing values; waist thickness can be added to a solid-to-base flight. Unsupported bodies, invalid dimensions and late unreadable styles refuse atomically without writes. The Model inspector exposes these edits for the actual selected flight and its parent, each as one Undo step and one remesh of the stair and flight.

[Native viewer evidence](https://github.com/LTplus-AG/ifc-lite/blob/f98785c722/docs/architecture/evidence/6232-stair-inspector/README.md) records the four dimension edits, each Undo and Redo, and the unchanged neighboring wall and windows.

#### Roofs by footprint

`addRoofToStore` (and `bim.store.addRoof`) makes a roof by footprint, as Revit's Roof by Footprint and Archicad's multi-plane roof do, when its rectangle or polygon params carry `EdgeSlopes` or `Overhang`. `EdgeSlopes[i]` is the slope of the edge from point i to point i+1, in radians. For a rectangle the edges run from its `Position` corner along +X and then anticlockwise. A slope of 0 is a gable end, or the high side of a mono-pitch roof. Each sloped edge is a pivot line: the roof's underside passes through it at the placement's height (`Position[2]`, storey-relative) and rises inward at its slope. `Overhang` (metres) carries every edge out horizontally. Eaves drop with their plane and gable ends move out as a rake. `Thickness` is measured square to each plane.

The planes come from a weighted straight skeleton of the footprint. Hip, gable, mono-pitch and L-, T- and U-shaped roofs work on convex and rectilinear footprints; anything else is refused with a reason, as are slopes over 85° and an overhang that would cross the eaves. The result is one `IfcRoof` whose Body holds one `IfcExtrudedAreaSolid` per plane: the plane's outline is swept straight up, which gives plumb eaves. Hips and ridges between planes of one slope meet exactly; where neighbouring slopes differ, their tops meet with a small step (`Thickness` × (1/cos a − 1/cos b)). Its `PredefinedType` (`ShapeType` on IFC2X3) follows from the slopes: `HIP_ROOF`, `GABLE_ROOF`, `SHED_ROOF`, `FREEFORM`, or `FLAT_ROOF` when no edge slopes. Angles are radians: values above π/2 receive a degree-conversion hint, but smaller numbers intended as degrees cannot be distinguished from radians. The definition is recorded on the roof as `IfcLite_RoofFootprint` (`Footprint`, `EdgeSlopes`, `Overhang`, `Thickness`, in metres and radians). Base quantities are derived from the planes as `Qto_RoofBaseQuantities` (`GrossArea` and `NetArea` sloped, `ProjectedArea` in plan).

Per-plane styles follow their footprint edges when edited. A flat plane's style is inherited by all new pitched planes. Flattening pitched planes preserves a shared uniform style; distinct or partly styled planes refuse atomically rather than losing or mixing their styles. Explicit `null` footprint fields are invalid; omit a field to use its default.


`editFootprintRoofInStore(dataStore, editor, roofId, patch)` (`bim.store.editRoof(ref, patch)`) changes one edge's slope (`Edge: { Index, Slope }`), every slope (`EdgeSlopes`), `Overhang` or `Thickness`, and rebuilds the planes as one atomic edit. The roof keeps its identity, placement and containment. The replaced shape is removed and a refusal writes nothing. The viewer and the headless SDK record it as one Undo step. The storey-free modelling factory, `createModellingStoreBackendWithoutStoreys`, also exposes this roof edit method.

```typescript
import { StoreEditor } from '@ifc-lite/mutations';
import { addRoofToStore, editFootprintRoofInStore, resolveSpatialAnchor } from '@ifc-lite/create';

const editor = new StoreEditor(dataStore, view);
const anchor = resolveSpatialAnchor(dataStore, storeyExpressId, view);
const deg = Math.PI / 180;
// A 12 x 10 m gable roof: the long edges slope at 30°, the short ones are gable ends.
const { roofId } = addRoofToStore(editor, anchor, {
  Position: [0, 0, 2.7], Width: 12, Depth: 10, Thickness: 0.3,
  EdgeSlopes: [30 * deg, 0, 30 * deg, 0], Overhang: 0.5,
});
// Hip the east end.
editFootprintRoofInStore(dataStore, editor, roofId, { Edge: { Index: 1, Slope: 45 * deg } });
```

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

`reassignHostedOpeningsInStore(dataStore, editor, sourceHostExpressId, moves)` applies a validated host split plan to a batch of `{ openingId, hostId, location }` entries. Each native-unit `location` is relative to its target host. The operation preserves opening/filling/relationship identities, changes the void relation's host when needed, and gives each edited occurrence fresh placements. Duplicate entries, ambiguous source void relationships and unreadable placements refuse atomically. Wall split, multisplit and slab split use this same placement writer and include all new placement records in one undo step.

In the Model workspace, a slab opening wholly on the new piece follows that piece while retaining its world position and identity. The larger piece retains the source slab identity. Canonical body bounds classify the entire cut; an opening crossing the split line, an unreadable body or an opening outside the readable direct-host frame refuses the split before publication. Split supports unrotated element placements and vertical extrusions; unsupported rotations and tilts refuse before edits, while in-plane solid transforms remain supported. The new slab, source profile and carried openings commit atomically as one Undo step, in both metre and millimetre files. A downward source extrusion keeps its body base and the opening's world elevation.

A curtain wall and a design grid have their own in-store builders. `addCurtainWallToStore(editor, anchor, params)` writes an `IfcCurtainWall` along a base line that aggregates its `IfcMember` mullions and transoms and its `IfcPlate` panels (`curtainWallLayout(params)` returns the same layout without emitting anything). `addGridToStore(editor, anchor, params)` writes an `IfcGrid` with tagged `IfcGridAxis` curves (`rectangularGridAxes` makes the numbered and lettered orthogonal axes). The viewer's Curtain Wall and Grid tools commit each as one undo step. `extractGridAxesForStorey(dataStore, storeyId, overlay)` reads back the grid axes that apply to a storey, from the file and from grids authored this session, as segments in storey-local metres; the Model workspace's snapping uses it, so walls, columns and curtain walls land on grid lines and grid intersections. Each segment carries the canonical `AxisTag`. Straight polylines can contain intermediate collinear points; bent polylines, unsupported curves and unreadable placement frames are counted in `skippedAxes` rather than offered as invented straight snap lines. Omitted optional placement directions keep the IFC defaults; explicit unresolved, zero or incomplete direction vectors on required placement hops are refused through the same canonical placement reader used for hosted geometry. Shared ancestor frames cancel when converting to storey-local coordinates, so an unreadable ancestor does not prevent extraction when neither side needs its transform. Trimmed line axes require a readable 2D `IfcLine` basis with a typed `IfcVector`, a nonzero `IfcDirection` and finite positive `Magnitude`, including when trimmed by points. Unreadable bases and nonfinite endpoints are counted in `skippedAxes`. A grid without `ObjectPlacement` uses identity only when its readable storey also omits `ObjectPlacement`; otherwise its axes are counted in `skippedAxes`.

The Model workspace's plan pane draws the active storey's design-grid axes and exact `AxisTag` bubbles, including grids authored during the session and grids read from an exported file. Fit includes the axes and reserves room for normal-sized label bubbles, so a grid beyond the building's outline can be framed. Oversized labels may clip; their margin cannot invert the view or pointer transform. Grid edits, Undo and Redo update the drawing. Grid type visibility, embedding-host `IfcGridAxis` hides, model visibility and model-qualified grid or axis entity hides apply to the plan drawing.

`gridIntersectionPlacement(editor, anchor, params, sourceStore?)` writes an `IfcGridPlacement` whose `PlacementLocation` is an `IfcVirtualGridIntersection`. Its two live `Axes` must belong to different rows of the same unambiguous `IfcGrid`. Generic IFC emission preserves valid curved and radial axes. A supplied `GridPlacementId` must be that grid's `ObjectPlacement`; a second intersection used for `RefDirection` must belong to the same grid. Invalid ownership, row membership and placement references refuse before the writer emits any records. `Offsets` remain metres and are converted to the anchor's native length unit.

For file-backed axes, pass the source `IfcDataStore` paired with the editor as the fourth argument, including when the spatial anchor was constructed manually. The reader combines that source with the editor's current overlay, deletions, retypes and positional edits. Overlay-only grids remain callable without a source context. Previously accepted calls with mixed or ambiguous owners, same-row axes or unresolved file ownership now throw; this is a breaking runtime validation contract. IFC2X3 still uses only a second intersection for `RefDirection`, while IFC4 and IFC4X3 may use a direction vector.

`addColumnOnGridToStore(editor, dataStore, anchor, params, { GridId, IntersectingAxes })` creates a column bound to the actual crossing of two readable straight axes. `params.Position` and `RefDirection` remain storey-local metres and section heading. The builder revalidates the live grid, crossing and placement, converts the height and heading into a local child of `IfcGridPlacement`, and emits the whole graph atomically. A moved/deleted grid, unsupported linear snapping basis or failed column parameters leaves no new records. The Column tool retains the actual active-model axis references from a grid-intersection snap and records the complete graph as one Undo/Redo step. Alt bypass, grid-edge snaps and solved points displaced from the crossing use ordinary local placement.

New bound columns use the same authored geometry completion as ordinary columns: they are revealed from Types view, and a parameter mesh supplies their initial geometry when native remeshing has no coordinate frame or returns no mesh. The remembered parameter mesh describes creation; moving the grid later requires successful native remeshing to update the live geometry. Saved IFC placement still follows the grid.

Grid-relative mini exports include the owning `IfcGrid`, whose inverse axis membership supplies the placement context in IFC2X3 and IFC4. `serializeEntitySubgraph` reports a grid placement in `unreadable` when its axes are deleted, belong to ambiguous owners or share one row. Callers must refuse remeshing that result. The exporter accepts valid curved and radial axes; straight-axis restrictions belong to the linear column snapping consumer.

`gridPlacementDependents(dataStore, mutationView, gridIds)` returns live model-local products whose placement follows the given grids, including local children and nested grid-bound grids. It reads the same effective records and ownership as mini export. Invalid bindings are excluded; with valid bindings present it scans placement and product buckets, otherwise it stops at grid placements. The viewer uses this in its shared remesh affected-set, so translating, setting the position of or rotating a grid replaces its bound products' geometry from canonical IFC placement. The move and its Undo/Redo use the same history batch.

Generic viewer position and rotation edits refuse products whose local placement descends from an `IfcGridPlacement`: the child's own zero is not an editable storey position. This avoids presenting grid-relative coordinates as directly writable storey coordinates.

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

Layer thicknesses and offsets are metres, converted to the file's length unit. Through the SDK these are `bim.store.addElementType`, `assignType`, `addMaterial`, `addMaterialLayerSet`, `addMaterialLayerSetUsage` and `assignMaterial`. The two `assign*` methods read the model's existing relationships themselves. Layer and layer-set schema fields are validated before creating any helpers: an unsupported field, including IFC2X3 layer or set `Description`, leaves the saved records, mutation journal and express-ID allocator unchanged. The loaded MCP model's `bim.store` adapter delegates the same six methods to this factory and records each call as one operation for `mutation_undo`, preserving earlier source and overlay edits. Required IFC2X3 `OwnerHistory` references resolve against that call's live mutation view.

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

By default, generated spaces use the inner wall faces, including joined wall thickness, and store paired `NetFloorArea`/`NetPerimeter` (inner faces) and `GrossFloorArea`/`GrossPerimeter` (centrelines) in `Qto_SpaceBaseQuantities`. Moving a bounding wall through `transformElementsInStore` updates generated space outlines and quantities in the same atomic edit; the SDK records it as one undo operation. If the move changes room topology or a room cannot be updated, the room is retained and the result returns a notice (also logged), while the wall move still succeeds. Transform hooks receive the draft editor and must write through it.

Generated spaces retain their snap tolerance and minimum area in `IfcLite_SpaceGeneration`, so boundary edits use the same detection settings after export and reopen. If a legacy generated space cannot be re-detected, the edit emits a warning identifying the space rather than silently keeping stale quantities.

The detector also picks up overlay walls (placed via `addWallToStore` since the model was parsed) when you pass an `OverlayWallReader` — the viewer's Room tool (**Auto**) does the same for freshly-drawn walls without a re-parse. `detectEnclosedAreas(segments, options)` is exported as the pure pipeline step if you want detection without IFC emission.

In the viewer, **Room → More** keeps the minimum area, name pattern, and schema-specific space classification alongside read-only candidate totals. `addSpaceToStore` validates the classification before writing: IFC2X3 uses `InteriorOrExteriorSpace`, IFC4 and IFC4X3 use `PredefinedType`, and `USERDEFINED` needs an `ObjectType`. An `EXTERNAL` space sets `Pset_SpaceCommon.IsExternal` to true.

The TypeScript SDK also exposes `bim.store.addStair(modelId, storeyId, params)`
and `addRailing(modelId, storeyId, params)` using the existing `StairInStoreParams`
and `RailingInStoreParams`. Dimensions are storey-local metres; the canonical
builders emit each target schema's attributes and native units. CLI and loaded
MCP backends require a readable live storey placement. The viewer preserves its
existing placement preparation and records/remeshes the same graph as its
Stair and Railing tools.

`bim.store.removeStair(ref)` delegates to `removeStairInStore(dataStore, editor,
stairId)`. It removes only a uniquely aggregated parent and single flight in
one atomic edit. Ambiguous/shared flights, incoming references from another
product, or unreadable live candidate records refuse before writing. Shared
shape, style, material and placement leaves remain; generic `removeEntity`
still removes one record. The viewer stashes/prunes the flight mesh and tree
row, then restores them with one Undo; Redo removes the pair again. Loaded MCP
records the pair as one public `mutation_undo` operation. These backend
capabilities are optional, so third-party backends can omit them and receive an
explicit unsupported-capability error. This slice does not register new QuickJS
bridge methods or a public MCP Redo tool.

`bim.store.replaceElement(ref, storeyId, element)` is another optional backend
capability. It accepts the existing eight ordinary builder kinds plus `stair`
and `railing`, with their canonical params. The existing product must belong to
one of those supported classes or their schema subtypes. Curtain walls, grids,
spatial structure and ordinary aggregate roots refuse before placement
preparation or graph changes; only uniquely owned single-flight stairs have
an assembly removal contract. Removal and creation share one
atomic draft; a late builder, placement or ownership refusal leaves the old
products, prior overlay, journal and allocator intact. The viewer completes
mesh/tree changes after commit and records one Undo/Redo batch; loaded MCP
records one public Undo operation. `model.addElement` uses this capability for
tracked updates and preserves the previous tracking entry on failure.

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

`bim.store.addColumn`, `addBeam` and `addMember` also accept the existing
`@ifc-lite/create` parameterised `Profile` types instead of rectangular dimensions.
Columns accept `RefDirection`, a finite non-zero horizontal vector in storey-local
coordinates; the canonical builder normalises it and defaults to `[1, 0, 0]`.
Profile dimensions and positions remain metres, including in millimetre models.
The SDK, viewer adapter and loaded-model MCP backend use the same
builders and validation. For example:

```typescript
const storeyId = bim.query().byType('IfcBuildingStorey').refs()[0].expressId;
const sectionColumn = bim.store.addColumn('default', storeyId, {
  Position: [2, 1, 0], Height: 3, RefDirection: [0, 1, 0],
  Profile: {
    Type: 'I', OverallWidth: 0.4, OverallDepth: 0.6,
    WebThickness: 0.05, FlangeThickness: 0.07,
  },
  Name: 'Turned I column',
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

`copyProductInStore` returns `copiedFrom`, a map from each new product id to its source id, including openings, fillings and assembly parts. Its optional fourth argument, `{ Name, shape }`, overrides the root product’s Name and preserves its parts’ names. Set `shape: 'own'` to copy a file element’s representation records instead of sharing its shape. `copyBatchInStore` accepts the same `shape` option. Representation contexts and representation maps remain shared; the element, its openings and fillings receive their own copied shape records. This adds those records to the exported file, increasing its size. A shape exceeding 50,000 records is refused atomically rather than silently shared. The default `shape: 'shared'` preserves the existing behaviour for file shapes and keeps copying session-created shapes. The map lets consumers mirror source geometry and property reads without reconstructing the copied relationships. The viewer records the complete copied subgraph as one undo step and re-meshes the copies through wasm. A part or hosted filling cannot be copied alone, and a placement disconnected from its storey is refused.

A copy of an element on a grid (one whose placement reaches an `IfcGridPlacement`) binds to the grid crossing it lands on, within a millimetre, among the crossings of the grids on its storey or its spatial ancestors. It gets a new `IfcGridPlacement` in the model's schema, with a local placement under it holding its height, heading and any offset. Landing on no crossing, it comes free as a plain storey-placed element. `CopyProductResult.boundToGrid` and `cameFree` list which is which, including a part on the grid in its own right. A part placed under a copied placement follows that copy and isn't listed. The viewer tells the person how many came free.

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

### Curtain walls and design grids in a loaded model

`bim.store.addCurtainWall(modelId, storeyExpressId, params)` creates the
`IfcCurtainWall`, its aggregated `IfcMember` mullions/transoms and `IfcPlate`
panels. It accepts the same `CurtainWallInStoreParams` as the Model workspace.
`bim.store.addGrid(modelId, storeyExpressId, params)` creates an `IfcGrid` with
straight tagged axes and a `FootPrint` representation. Both write the complete
graph in one atomic operation; the viewer and headless hosts record one Undo.

```typescript
function addDesignGrid(modelId: string, storeyExpressId: number) {
  return bim.store.addGrid(modelId, storeyExpressId, {
    Name: 'Design grid',
    UAxes: [{ Tag: '1', Start: [0, 0], End: [4, 0] }],
    VAxes: [{ Tag: 'A', Start: [2, -2], End: [2, 2] }],
  });
}
```

Lengths are metres. Curtain-wall endpoints and grid `Position` are
storey-local; axis endpoints are grid-local; `Direction` is radians.
`bim.store.addColumnOnGrid(modelId, storeyExpressId, params, binding)` accepts
rectangular or profiled column parameters and a `GridColumnBinding` containing
`GridId` and the two actual `IntersectingAxes` express ids. `Position` must
match their current crossing in the storey frame. A stale crossing, foreign
axis owner or unsupported placement refuses the entire operation without
allocating partial geometry. The emitted column retains a real
`IfcGridPlacement` binding when exported. These optional backend capabilities
throw a clear error on a host that does not implement them.

`bim.store.editHostedElement(ref, patch)` exposes the same physical edit used by
hosted sliding and the Model inspector. `Offset` and `Sill` are metres in the
host frame; `OverallWidth` and `OverallHeight` resize the occurrence and its
opening together. The edit preserves identity, metadata, relationships and
other instances of shared source geometry. It refuses overlapping cuts,
out-of-host dimensions and unsupported geometry atomically. Viewer and MCP
hosts record one Undo batch and the viewer remeshes the host, cut and filling.

```typescript
bim.store.editHostedElement({ modelId: 'building', expressId: 1262 }, {
  OverallWidth: 1.2, OverallHeight: 1.4,
});
```

Shared geometry edit planning uses `expandAffectedSet(store, view, ids, cause)`
from `@ifc-lite/export` to include live hosted products when placements or host
bodies change. `editOwnershipRefusal(store, view, writtenIds, allowedProducts)`
checks effective source and overlay references before an in-place write and
refuses leaves shared with unrelated products. Callers keep planning and writes
inside one atomic mutation transaction. The viewer's move, rotate and align
commands use this common plan and preserve the IFC storey frame and model units.

The shared `copyBatchInStore(dataStore, editor, expressIds, transforms, options?)`
operation prunes selected hosted/assembly dependants and copies the resulting
roots atomically. `copySourcesInStore(context, expressIds, copyCount?)` reports
refusals before planning and checks fan-out after pruning carried children; the
optional count defaults to one. `copiedProductsInStore` supplies the viewer
preview's products. `copiesOfSelection(expressIds, results, transformCount)`
maps every selected element to its copy, per transform and in selection order:
a door or window selected with its wall, or a part selected with its assembly,
is its copy inside the host's copy, so `bim.store.copyElements`,
`arrayElements` and `copyToStoreys` return one ref per selected element per
transform. A selected element that no copy carries throws; it is never dropped.
`arrayCopyTransforms(params)` is the same linear/polar planner used for the
viewer preview and commit; its count includes the original selection, and a
full polar turn omits the coincident final copy. Each batch is bounded to
10,000 new root copies before allocation. A separate work budget permits at
most 50,000 actual product writes per batch, including carried assembly parts,
openings and fillings. Deep acyclic assembly traversal is iterative; excessive
reference fan-out refuses before emission. Parent placement frames between an
occurrence and its storey must be upright; tilted or negative-Z parents refuse
rather than projecting the requested movement. Tilted occurrence leaves remain
supported under upright parents. Unknown array modes and overflowing
derived directions/extents refuse before preview or writes. Native-unit
conversion and placement composition also refuse nonfinite output atomically. The host records
its compound Undo
batch and re-meshes returned products after success.

### Physical command edits on loaded models

The SDK's `bim.store` methods use the same atomic geometry edit cores as the
viewer commands. References carry a model ID and model-local EXPRESS ID.
Coordinates and offsets are in IFC storey-local metres; planar rotations use
radians about an explicit pivot. The viewer adapter handles rendering and
history after the shared IFC operation commits.

- `copyElements(modelId, expressIds, transforms)` copies selected products for
  each transform, including their hosted openings/fillings and assembly parts.
  Selecting a host and its filling copies that filling once.
- `duplicateElement(ref, { offset, Name? })` uses the same copy graph with the
  Duplicate naming policy. Supply the IFC offset explicitly; the viewer's
  directional bounds gesture calculates its own offset.
- `arrayElements(modelId, expressIds, params)` uses the viewer's linear/polar
  array planner. `count` includes the original selection; the returned references
  identify only the new copies.
- `transformElements(modelId, expressIds, operation)` accepts a planar `move`
  with `delta` or `rotate` with `pivot` and `angle`. Align and plan movement use
  the same writer after their gesture computes the delta.
- `setElementSize(ref, patch)` edits supported wall `Height`/`Thickness`, slab
  `Thickness`, or linear extrusion/profile `Depth`/`XDim`/`YDim`. Unsupported
  imported profile shapes refuse instead of being replaced with primitives.
- `resizeWall(ref, start, end, options?)` changes wall endpoints and carries
  joined ends by default. Set `moveJoinedEnds: false` explicitly to disable that
  endpoint policy.
- `splitElements(modelId, requests)` commits the entire selection atomically.
  Wall/linear cuts use a distance; slab cuts use two planar points. The larger
  piece retains source identity and the added piece receives a fresh GlobalId.
- `trimExtendElement(ref, params)` uses `mode`, `click`, and a live wall boundary
  or explicit finite boundary segment, with the same shape and host refusals as
  the viewer.

Each operation records one logical Undo batch. A refusal preserves the graph,
mutation journal and allocation state. Edits resolve current overlay entities;
geometry shared with unrelated occurrences is refused when writing it would
change those occurrences. Backend capabilities are optional: a custom backend
must implement a method before its namespace can execute it.

### Native Room commands

`await bim.store.roomCommand(modelId, storeyExpressId, command)` derives rooms
from current native wall meshes. It shares the viewer's native layout cache,
occupancy checks, supported space footprint reader and IFC writer. Actions are
`query`, `auto`, `autoAll`, `pick` (with `point`), `footprint`, `update` (with `expressIds`),
and `edit` (with a `drag`, `split`, `remove` or `prune` layout operation).
`query` returns candidates without writing. Writes return `created`, `updated`,
`deleted` and `skipped` references and form one logical Undo batch. Supplied
footprint placement remains available through `addSpace`.

`autoAll` enumerates every current storey in the explicitly chosen model (the supplied storey ID is its anchor), prepares one detached native graph and commits one recorded action. Its `storeys` result contains each native storey ID, coverage status, candidate population, existing room count and created references. Existing room counts include all live owned `IfcSpace` entities, including unsupported or absent geometry. `effectiveRoomIdsByStorey(store, mutationView, storeyIds)` supplies the same complete bounded native population to SDK preparation and Viewer review; footprint readability only controls geometry planning. `unavailable` coverage refuses the entire commit; `noWalls`, `occupied` and `noFaces` are known no-write storey outcomes. Empty results create no Undo group. This never runs across other federated models. Complete preparation refuses above 128 storeys, 128 candidates or 4096 contour vertices rather than truncating an all-storey claim. Hosts can supply `NativeRoomGeometry.validate` to pin actual mesh/frame inputs across asynchronous preparation and held approval.

Settings use metres: `weld`, `height`, `z` and optional edit
`tolerance`; `boundary` is `inner`, `center` or `outer`. `namePattern`,
`PredefinedType` and `ObjectType` control created room metadata. The runtime
requires the WASM geometry package. The command refuses if its model changes
while native geometry is preparing. In-process callers can supply an
`AbortSignal`; cancellation before commit leaves IFC history unchanged.

Native Room layout edits also enter ordinary Undo/Redo history when no IFC rooms exist yet. The `recordSessionMutation` helper records a `SESSION_EDIT` marker for local domain state; it does not modify IFC attributes, allocate entities or emit collaboration operations. Hosts retain the native layout under the actual history head, so Undo/Redo restores the corresponding plate.

For append-only authoring, `view.getMutationCount()` captures the current journal cursor and `view.getMutations(cursor)` reads its appended suffix. This bounds recording overhead by the current call; atomic graph preparation remains a separate cost. Viewer ordinary creation publishes its collaboration graph before adding local Undo history and restores its prepared overlay if publication refuses.

Native Room SDK preparation raises `RoomCommandConflictError` when another Room command owns preparation or the model changes before commit. Callers may retry against current state. Abort signals retain their cancellation reason; no Room commit is published after cancellation.

Hosts that use `createRoomCommandBackend` can call its asynchronous
`prepareRoomCommand(modelId, storeyExpressId, command)` before asking for
approval. The returned `PreparedRoomCommand` exposes a detached native
`preview` model and the planned `result`. For an edit, `layoutAfter` contains
the detached post-edit native faces, including a layout-only cut with no
materialized IfcSpace. The existing `result.candidates` keeps its pre-edit
candidate meaning; hosts show `layoutAfter` to review the approved new layout.
Preparation changes no live IFC
graph or Undo history. `validate()` checks the captured model and source-byte
facade identity, overlay,
history and retained layout. `commit()` applies the whole captured action
synchronously through the host recorder, once. Auto approves every captured
untaken face; this interface does not offer per-room subset approval.
Always call `dispose()` in a `finally` block or when abandoning a review so
an uncommitted duplicate native plate is freed. A newer preparation on the
same backend/model supersedes an older approval. Native queries may refresh
geometry and the retained cache, but do not write IFC graph changes.

`minArea` uses square metres. Layout-only edits before any IfcSpace exists
remain session Undo state; exporting IFC does not serialize that retained
layout unless an operation has materialized rooms in the graph.

### Detecting concurrent overlay edits

`MutablePropertyView.getMutationRevision()` returns an O(1) invalidation token for the live overlay. Capture it before asynchronous preparation and compare it afterward together with the model and view identities. Canonical edits, history-free edits, Undo/Redo and atomic publications advance the token; a rejected detached draft does not change the live token. Conservative increments may invalidate unchanged geometry. The token is local to one view, is not serialized, and must not replace the recorded Undo head.

`readRelatedLists` normally returns syntactically valid relating references and
excludes explicit IFC unset targets. Its optional fourth argument
`{ includeMalformedRelatingTargets: true }` also inventories relationships whose
relating slot is malformed or missing; these rows omit `relatingId` and must be
refused as unknown. A reference to a missing entity retains its `relatingId`, so
consumers must separately validate that the target exists and conforms to the
required IFC type. Explicit unset remains excluded.

`view.getQuantitiesForEntity(entityId, baseProvider?, includeEmptyInstances?)`
retains a known source quantity-set `globalId` while applying canonical instance
claims to same-named sets. Ordinary reads omit instances whose last numeric
member was deleted. A native exporter can pass `true` as the third argument to
retain those empty instances long enough to remove only their native ownership
reference. The optional base provider can supply current native quantity sets
without changing the view's installed source provider. This does not change the
name-based mutation API or spread an edit across other same-named definitions.

### Same-identity storey reassignment

`planStoreyReassignment(dataStore, view, selectedIds, sourceStoreyId, destinationStoreyId)` reads the complete effective product/dependency/placement state without writing. `reassignElementsToStoreyInStore(dataStore, editor, selectedIds, sourceStoreyId, destinationStoreyId, expected?)` commits that operation atomically. `planStoreyReassignmentCandidates(dataStore, view, selectedIds, sourceStoreyId, destinationStoreyIds)` reads up to 20 distinct destination candidates using one effective Root/relationship inventory and reports each candidate's plan or refusal. This snapshot is scoped to one synchronous request and never retained across edits. Both storeys and every product must belong to the supplied model. An expected plan pins both `sourceStorey` and `destinationStorey` as `{ expressId, GlobalId }` records and refuses changed identities, membership, dependencies, metadata or frames, including a valid unique replacement storey GlobalId.

The operation preserves product EXPRESS IDs, GlobalIds, representation and metadata references, and world placement. It re-expresses existing local placements in the destination storey's canonical full 3D frame; dependent placement chains retain their original parent identities. Native coordinates remain in file units, so metre and millimetre models use the same operation without guessed scale factors. Hosted openings/fillings and aggregate/nested parts travel with their owning roots. Spaces retain spatial aggregation; physical products retain containment. Unrelated source members remain in place. Distinct source relationships remain distinct: a wholly moved relationship retains its EXPRESS ID, GlobalId and metadata; a partial relationship retains its source identity and creates a separate destination entry with fresh identity and copied metadata. Complete relationship attributes are included in the stale-state pin.

```ts
import type { IfcDataStore } from '@ifc-lite/parser';
import { StoreEditor, recordCompoundMutation } from '@ifc-lite/mutations';
import { planStoreyReassignment, reassignElementsToStoreyInStore } from '@ifc-lite/create';

function reassignProducts(dataStore: IfcDataStore, editor: StoreEditor,
  ids: number[], sourceStoreyId: number, destinationStoreyId: number) {
  const view = editor.getMutationView();
  const expected = planStoreyReassignment(dataStore, view, ids, sourceStoreyId, destinationStoreyId);
  return recordCompoundMutation(view, draft => reassignElementsToStoreyInStore(
    dataStore, new StoreEditor(dataStore, draft), ids, sourceStoreyId, destinationStoreyId, expected));
}
```

Select 1–200 distinct roots; the complete dependency closure is bounded to 5,000 products and the effective relationship inventory to 2,000,000 references. Missing or duplicate identities/ownership, detached hosted or assembly children, cycles, shared placements, unsupported or unreadable world frames, and spatial roots such as sites/buildings/storeys refuse. IFC2X3 requires OwnerHistory; IFC4 and IFC4X3 allow it to be omitted. Native grids and grid-based product placements are unsupported; ordinary local placements may include translated, rotated or tilted frames. A refusal or late transaction failure preserves the graph, journal and allocation state. Recorded Undo restores the complete graph and journal; the native ID allocator remains monotonic after a successful operation.

### Storey authoring

`@ifc-lite/create` adds, renames, re-levels and deletes `IfcBuildingStorey` in a parsed model (#9013). `bim.store` runs the same functions. Lengths are metres, in the frame the parsed spatial hierarchy reports storey elevations in, and are written in the file's own length unit. Storeys form one sequence per spatial parent (their building, or the site or project when the file aggregates them there): neighbours, floor-to-floor shifts, elevation clashes and suggested names are taken within it. A storey nothing aggregates has no neighbours; its elevation can be edited, but a floor-to-floor edit is refused. An element another storey contains but this storey's elements host (a window filling an opening in a wall here) belongs to its own storey: an edit that would separate it from its host is refused.

- `addStoreyInStore(dataStore, editor, { Name, Elevation })` copies the nearest storey's conventions. It joins the spatial element that aggregates `referenceStoreyId` (usually the building; a file that aggregates its storeys under the site or the project keeps that). Without a reference, it joins the one spatial element the storeys share, or `buildingId`, which a model with several buildings requires. The new storey is aggregated under the same spatial parent, which extends that parent's existing `IfcRelAggregates` instead of adding a second decomposition. Its `IfcLocalPlacement` hangs from the same `PlacementRelTo` with the same axes, lifted by the elevation difference. Any offset the file keeps between `Elevation` and placement Z is kept. It is refused when the name is empty, the elevation is already taken, the `GlobalId` is already carried by a live entity, or `buildingId` disagrees with `referenceStoreyId`'s building. `suggestStorey(inventory, storeyId, 'above' | 'below', fallbackName)` proposes a name, elevation and height from the neighbouring storeys.
- `planStoreyLevelEdit(inventory, edit)` is a dry run, and `applyStoreyLevelEdit(dataStore, editor, edit, expected?)` writes it atomically. With `expected`, the reviewed plan, it refuses (code `stale`) a model that changed since: a point moved, an axis turned, a product attached or a storey re-levelled. The plan's `fingerprint` hashes the moved storeys and every written placement chain. Edits:
  - `{ kind: 'elevation', storeyId, Elevation }` moves one storey.
  - `{ kind: 'floorHeight', storeyId, Height }` shifts every storey above by the same delta.
- Geometry follows storeys. Everything a moved storey holds moves with it, and nothing else does:
  - Contents hanging from the storey placement need no write of their own.
  - Contents placed relative to the building or the world, which is common in exported files, get their own root placement lifted.
  - A product of another storey that hangs from a moved placement is compensated so it stays put.
  - A product bound to a grid (`IfcGridPlacement`) follows the grid's placement: it moves with a grid on its own storey, and a grid-bound product of another storey under a moved grid is refused, because a grid placement cannot be compensated.
  - Every move is a fresh `IfcCartesianPoint` and `IfcAxis2Placement3D`, so a shared origin point is never moved.
- An edit is refused before anything is written, with a specific `code` and `message`, when it would:
  - leave no height between storeys (`spacing`);
  - pass a neighbour (`crossing`);
  - measure floor-to-floor on the top storey (`topStorey`);
  - move a placement that elements on another storey share (`sharedPlacement`);
  - meet a placement that cannot be read;
  - move a storey holding more than 50,000 products (`tooLarge`).
- `planStoreyDelete` / `applyStoreyDelete(dataStore, editor, storeyId, mode, expected?)` delete a storey without orphaning anything. With `expected`, it refuses (code `stale`, checked before any other refusal) when contents were added after the review, or the storey or a reviewed product was edited or moved since; the plan's `fingerprint` hashes the contents' records and placement chains. Modes:
  - `{ kind: 'empty' }` is refused while the storey holds elements.
  - `{ kind: 'move', targetStoreyId }` moves them through the same-identity reassignment above. It is refused for a storey that nests products through `IfcRelNests`, which have no spatial owner to move.
  - `{ kind: 'deleteContents' }` removes them with the storey. It is refused while another storey's element fills or stands on one of them (an opening's filling, a grid's column).

  The storey's placement is kept, and relationships listing it are narrowed. A model always keeps one storey.

```ts
import type { IfcDataStore } from '@ifc-lite/parser';
import { StoreEditor, recordCompoundMutation } from '@ifc-lite/mutations';
import { addStoreyInStore, applyStoreyLevelEdit, planStoreyLevelEdit, readStoreyInventory } from '@ifc-lite/create';

// Two writes, two Undo steps: the storey is added even if the raise is then refused,
// so the caller reports the refusal (and can undo the add) rather than retrying the add.
function addLevelAndRaise(dataStore: IfcDataStore, editor: StoreEditor, groundId: number) {
  const view = editor.getMutationView();
  const { storeyId } = recordCompoundMutation(view, (draft) =>
    addStoreyInStore(dataStore, new StoreEditor(dataStore, draft), { Name: 'Level 2', Elevation: 3 }));
  const edit = { kind: 'floorHeight', storeyId: groundId, Height: 3.5 } as const;
  const plan = planStoreyLevelEdit(readStoreyInventory(dataStore, view), edit);
  if (plan.refusals.length) return { storeyId, raised: false, refusals: plan.refusals };
  recordCompoundMutation(view, (draft) => applyStoreyLevelEdit(dataStore, new StoreEditor(dataStore, draft), edit, plan));
  return { storeyId, raised: true, refusals: [] };
}
```

Elements whose shape depends on storey spacing follow the edit in the same transaction:

- **Attached elements (#9296).** Walls, columns (grid-bound ones included), beams, members and curtain walls whose top is attached to a storey above move their top by `Δtarget − Δown`, so the top keeps its offset from that storey:
  - a wall takes the new height through the same section edit the inspector uses, which refuses an opening that would end above the new top. An existing `Qto_WallBaseQuantities` is kept true (a wall with more than one such set has only the first updated, and the plan says so in `notices`, `wallQuantitiesPartial`): Height and the gross side area and volume scale with the height, and the net values change by the same amount as the gross ones (converted between their units when a quantity carries its own, and taken from the set's Length, Height and Width when the gross value is missing);
  - a column takes a new extrusion depth;
  - a level beam or member is lifted whole, so it stays at the same depth under the storey; a vertical one is lengthened; a sloped one (a brace from one level to the next) keeps its foot and is turned to reach the new top;
  - a curtain wall is laid out again at the new height, not stretched: mullions take the new height, and every part keeps its identity (`relayoutCurtainWallHeight`). The file records no V-grid spec, so transoms at exact equal fractions of the height are re-spaced proportionally, whether they came from a bay count or from explicit heights that happen to divide the wall equally (`VGrid: [1, 2]` on a 3 m wall); any other transom keeps its height above the base (#9352).

  A height of zero or less is refused before anything is written (code `dependent`). Attachment is recorded, never inferred from a height that happens to match the spacing:
  - `IfcLite_StoreyAttachment.TopConstraint` (IfcLabel) holds the target storey's GlobalId. It holds `NextStoreyAbove` for an element drawn attached before any storey existed above; the first storey added directly above binds it, and `addStoreyInStore` resizes the element to reach that storey. One whose body or placement it cannot read is still bound and returned in `unresizedWalls`, so later edits list it as not resized.
  - `IfcLite_StoreyAttachment.TopBinding` says how a storey target is meant. `Relative` is Archicad's "home storey + 1": a storey inserted between the element's storey and its target re-binds it (`addStoreyInStore` lists it in `bindings`, and `planStoreyAdd` reports it before anything is written), and a copy to another storey attaches to the storey above its new one. `Explicit` is Revit's "Up to level: X": it stays on X. A record without `TopBinding` (every file written before #9296) is relative when its storey is the next storey above the element's own, which is what the Model workspace's "To storey above" wrote, and explicit otherwise, so such a file keeps its meaning.
  - `TopConstraint` may hold a slab's or a roof's GlobalId instead: the top ends on its underside and follows it when the target or the target's storey moves. Only walls attach to a roof; a roof by footprint cuts the wall to its planes, as described below.
  - Revit's own `Constraints` › `Top Constraint` = `Up to level: <name>` is read as an explicit binding.
  - An element with neither record keeps its height. `Fixed` in the IfcLite record is an explicit fixed height and overrides a Revit record; `clearTopAttachment` writes it for an element Revit recorded as attached.
  - A record that names nothing it can follow (a deleted storey's GlobalId, a Revit level renamed or shared by two storeys, or an unreadable underside) is not guessed at: the element keeps its height and the plan lists it in `notices` (`wallAttachmentUnresolved`; `topAttachmentProblem` gives the reason).
  - `readTopAttachment` / `writeTopAttachment` / `clearTopAttachment` read and write the record. `setTopConstraintInStore(dataStore, editor, elementId, constraint)` sets it and fits the top there now, atomically: `{ kind: 'storeyAbove' }` (relative), `{ kind: 'storey', storeyId }` (explicit), `{ kind: 'slab', slabId }`, `{ kind: 'roof', roofId }` (walls) or `{ kind: 'fixed' }`.
- **Stairs and their railings.** A stair whose top tread lands on a storey is refit with the riser height it was built with, rounded to whole risers. It lands on a storey when its base plus `NumberOfRisers × RiserHeight` equals that storey's elevation within 1 mm. The refit runs through `editStairDimensionsInStore`, which now also takes `NumberOfRisers`, so the IfcStair and IfcStairFlight keep their identities. A rise no flight fits (under 0.30 m), or a waist that no longer fits, is refused. A railing that runs up the stair (the railing builder's layout on the stair's storey, from its foot to its top tread, beside or over the flight) is stretched with it: along the new run and up the new rise, keeping its height above the pitch.
- **What is left alone.** Attached elements that are not simple extrusions, and stairs that are not a single stepped flight this editor can rebuild, still move with their storey but keep their shape. The plan lists them in `notices`, before anything is applied.

`planStoreyLevelEdit` runs the complete write in a discarded draft, so its `refusals` include late ones such as an opening above a wall's new top. The plan's `walls`, `attached`, `stairs`, `railings` and `movedElementCount` are what an impact summary shows.

**Copies to other storeys.** `copyBatchInStore` (`bim.store.copyElements`) re-resolves the top attachment of a copy on another storey: a relative top attaches to the storey above the copy's storey and keeps its offset from the floor it reaches, so its height follows that storey's floor-to-floor; an explicit top stays on its storey and is refit to reach it (a copy whose base lands at or above it is refused); a slab target follows the slab's copy when the slab was copied in the same operation. A copy that needs a new height but still shares its source's shape from the file (file shapes are shared by reference) is not resized, since that would resize the source: it is recorded fixed at the source's height and listed with the reason in the copy result's `unattachedTops`, and so is a copy whose body or placement cannot be read where its height must change. `copyToStoreysInStore(dataStore, editor, ids, storeyIds)` (`bim.store.copyToStoreys`) copies one selection onto several storeys as one atomic, undoable operation and returns, per storey, the results, the copy of each selected element (`copies`) and that storey's `unattachedTops`. `copyProductInStore` writes the copy and its re-bind as one atomic edit, so a refusal leaves nothing behind. Copy results also retain copied child-to-parent links in `carriedBy`, so a selected inner assembly receives notices for the parts it carries. In the SDK each returned ref carries `unattachedTops: [{ expressId, reason }]` for the copies it made that keep their height; the MCP `copy_elements` and `array_elements` tools list them in their message and result, and the viewer shows one toast.

**Authoring default.** `bim.store.addWall`, `addColumn`, `addColumnOnGrid`, `addBeam`, `addMember` and `addCurtainWall` take an optional `TopConstraint` (a `setTopConstraintInStore` constraint, or `'auto'`, the default). `auto` is the Model workspace's "To storey above": an element whose top lands on the storey above its own (within 1 mm) is recorded attached to it, relatively; anything else is fixed. The Model workspace's Wall, Column and Curtain Wall tools draw up to the storey above under that default and record the attachment in the same Undo step; the Beam tool records it when the beam's top lands on the storey above. A level beam or member lands with its top face, the way a storey edit lifts it whole. The viewer's `bim.store` applies the constraint the same way as headless, curtain walls and grid columns included.

`bim.store` exposes the same operations in every host: the SDK's headless backend, the viewer (through the storey manager's undo-batched path) and its script sandbox, the MCP `storey_*` tools and `ifc-lite storey`. The methods are `listStoreyLevels`, `suggestStorey`, `addStorey`, `renameStorey`, `planStoreyEdit`, `editStorey`, `planStoreyDelete` and `deleteStorey`. `editStorey` and `deleteStorey` take the reviewed plan as an optional last argument. Headless backends record each write as one Undo step. `listStoreyLevels` counts every storey, however large; only a plan refuses a storey holding more than 50,000 products. The round-1A methods `planAddStorey`, `setTopConstraint` and `copyToStoreys` are on the SDK's headless backend (and so on `ifc-lite run` scripts); the viewer adapter, its sandbox, MCP and `ifc-lite storey` follow in #9352.

A wall attached to an authored footprint roof is trimmed to its actual underside,
including ridges and valleys. The roof must cover the whole wall, and both
placements must be upright. A roof or slab translation, a roof shape edit, and a
storey edit refit the attached tops in the same atomic edit. An invalid fit leaves
the original model unchanged. Fixed detaches the top and keeps its last shape;
attaching to a storey or slab restores a planar top.

The shared placement and transform operations refit attached tops inside their
transaction and return every product that needs remeshing. Custom hosts that write
placements directly can call
`refreshTopAttachmentsInStore({ dataStore, view, editor }, movedElementIds)`
inside their transaction and remesh the returned product ids.

Walls fitted to pitched roofs retain their editable base extrusion beneath the roof cuts. Their derived quantities retain length, width and floor footprint; prism height, side area and volume are omitted until the quantity reader can measure the finished CSG body. Loaded files retain their original quantity sets under the normal opt-in refresh policy.

Cyclic or unreadable session-created shape graphs are refused atomically in both copy modes. Valid shapes retain the default sharing policy.

The `IfcAttributeValue` typed marker accepts `number[]` for IFC4 indexed segments:
`{ typed: { type: 'IfcLineIndex', value: [1, 2] } }` writes `IFCLINEINDEX((1,2))`.
`IfcArcIndex` requires exactly three indices; all indices must be positive integers.
Other typed markers continue to accept scalar values.

When migrating an attribute reader, narrow `value.typed.value` with
`Array.isArray` before passing it to a scalar-only function. The typed payload
can now contain segment indices as well as a string, number or boolean.

For an entity-scoped diff, use `view.getEffectiveChanges(expressId)`. It returns
that entity's current effective changes in the same order as filtering
`view.getEffectiveChanges()`, while reading its indexed mutation rows.
`view.getNewEntitiesReferencing(expressId)` enumerates created records whose
**authored attributes** contain a `#expressId` reference. These are candidates:
apply named and positional overrides and deletion checks before interpreting
an effective relationship. Slot overrides that introduce a reference must also
be considered through `view.getAttributeOverrideEntityIds()`. Pass a list of
IFC classes to that method to narrow created candidates by their effective
class; edited source records remain conservative candidates for the caller to
check against its source store. The optional second argument narrows creations
to overrides that could contain a reference to that ID. These remain
candidates; verify their effective slots with the relevant schema and grammar.
`view.getAttributeOverrideReferenceCandidates(id)` also indexes source edits
that might introduce a reference. Combine these with the immutable source and
authored reference indices; retained or removed references need those indices.

The ordinary entity getters keep their mutable-array contract. Reference
lookups conservatively recheck a record after its attribute array is exposed,
including later edits through a retained alias. Pure readers can use
`readNewEntity`, `readNewEntities`, and `readNewEntitiesOfType`. These return
frozen copies, so a write through a borrowed array throws instead of editing a
record behind the reference index. Reference-query results are borrows too.
Borrowing marks nothing as exposed, and inside a transaction a borrow reads an
unmodified row without copying it into the draft. Use the ordinary getters or
mutation methods for writes. `StoreEditor.readNewEntity` provides the same
read-only borrow. `readNewEntityKinds(type?)`, `hasNewEntity(id)` and
`getNewEntityCount()` answer enumeration and membership without reading any
payload.

`planFootprintRoof(footprint, edgeSlopes, overhang)` exposes the same pure planner
used by the roof builder for previews. Coordinates and overhang share a length
unit; edge slopes are radians. `roofPlaneHeightAt(plane, point)` reads a planned
plane's underside height above the roof placement. Invalid footprints throw with
a reason before any entities are written.

In a shared viewer session, roof creation publishes its body and footprint
definition together before committing the local draft. If publication fails,
creation leaves no roof, undo entry or partial definition on peers; the same
creation can be retried. Mesh and spatial-tree registration follow a successful
commit.

### Persisting an overlay

Use `snapshotOverlay` and `restoreOverlay` from `@ifc-lite/mutations` to save
edits without copying the source IFC file. The versioned JSON contains current
logical rows, created entities in creation order, forgotten creation rows, the
allocator and the mutation journal. It includes edits made with `skipHistory`.
Source tables, extractors, derived indices, GPU meshes and Revert registries are
not persisted. Restore rebuilds class and reference indices.

```ts
import { MutablePropertyView, snapshotOverlay, restoreOverlay } from '@ifc-lite/mutations';

async function persistAndRestore(view: MutablePropertyView, destination: MutablePropertyView, completeSource: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', completeSource);
  const sourceContentHash = 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const saved = snapshotOverlay(view, { sourceContentHash, schema: 'IFC4' });
  restoreOverlay(destination, saved, { sourceContentHash });
  return destination;
}
```

Supply the digest of the actual complete source buffer, using SHA-256 or another
hex digest of at least 256 bits (an optional algorithm prefix is accepted).
The viewer's full `placement-sha256-1m-v1:` identity is accepted. The package
compares hashes; it cannot check which bytes the caller hashed. A mismatch
throws `OverlaySourceMismatchError` before changing the view. Schema and
creation time are informational. A newer snapshot version is refused.

Prepare the destination against the same parsed source, attaching its normal
base table/extractors before restore. Restore refuses an occupied view unless `{ replace: true }` is supplied.
Successful replacement advances the live mutation revision, invalidating old
prepared edits; it never lowers the allocator below the target's watermark.
Malformed rows and input over the default 64 MiB UTF-8 limit are refused before
publication. A caller can set `maxBytes`; data is bounded to 256 nested levels
and two million values. Nonfinite values and negative zero survive
in attributes as well as property/quantity rows.

A host may pass optional `history: { undo, redo, groups, parked }` to
`snapshotOverlay`: mutation IDs in the two stacks, mutation/group-ID pairs,
and entity payloads needed to redo creations. `restoreOverlay` returns that
history after validation. Invalid or host-only undo records drop the entire
history and return `historyDroppedReason`, while retaining the valid edits.
The journal's model IDs are preserved; bind host stacks to the same logical
model. Rebuild meshes and host Revert state separately after restoring.

For asynchronous work on a fork, use
`const fork = view.prepareAtomic(draft => draft).result` and leave that
transaction uncommitted. Later asynchronous code can edit, snapshot or export
the detached fork without publishing it to the original view.

Walls added through `bim.store.addWall` join coincident, non-parallel chain
endpoints automatically. Crossings and T junctions still use `joinWalls`.
Moving an `IfcGrid` with `transformElements` carries its grid-bound products.
The headless CLI supports `alignElements` using current native mesh bounds,
including hosted cuts, rather than uncut parametric bounding boxes.
