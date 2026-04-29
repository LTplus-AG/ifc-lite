# @ifc-lite/mutations

Property editing and mutation tracking for IFClite. Edit IFC properties in-place with full change tracking, undo/redo, and export.

## Installation

```bash
npm install @ifc-lite/mutations
```

## Quick Start

### Property edits

```typescript
import { MutablePropertyView } from '@ifc-lite/mutations';

// Create a mutable view (params: PropertyTable | null, modelId)
const view = new MutablePropertyView(propertyTable, 'my-model');
view.setProperty(entityId, 'Pset_WallCommon', 'FireRating', 'REI 120');

// Get all changes
const mutations = view.getMutations();
```

### Store-level edits

For raw STEP edits — adding entities, deleting them, overriding positional
arguments on entities without symbolic attribute names — pair the view with
a `StoreEditor`:

```typescript
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

const view = new MutablePropertyView(propertyTable, modelId);
const editor = new StoreEditor(dataStore, view);

// Add a fresh entity (e.g. an IfcRectangleProfileDef)
const profile = editor.addEntity('IFCRECTANGLEPROFILEDEF', [
  '.AREA.', null, '#34', 0.6, 0.4,
]);

// Override a single positional STEP arg by index
editor.setPositionalAttribute(profile.expressId, 3, 0.7);  // XDim → 0.7

// Tombstone an entity
editor.removeEntity(unwantedExpressId);
```

Edits accumulate in the same overlay used by `setProperty` / `setAttribute`
and materialise the next time you call
`StepExporter.export({ applyMutations: true })`.

## Features

- Mutation overlay on read-only IFC data
- Undo/redo support (via viewer store)
- Change sets for grouping related mutations
- Bulk query engine for updating many entities
- CSV import for spreadsheet-based updates
- **Store-level edits**: `StoreEditor` for `addEntity` / `removeEntity` /
  `setPositionalAttribute` over a parsed `IfcDataStore`
- Export modified data

## API

See the [Property Editing Guide](../../docs/guide/mutations.md) (covers
both property and store-level edits) and the
[API Reference](../../docs/api/typescript.md#ifc-litemutations).

For higher-level builders that emit fully-anchored sub-graphs (e.g. an
`IfcColumn` with placement, profile, and rel-contained-in-spatial-structure)
into a `StoreEditor`, see [`@ifc-lite/create`](../create) — specifically
`addColumnToStore` and `resolveSpatialAnchor`.

## License

[MPL-2.0](../../LICENSE)
