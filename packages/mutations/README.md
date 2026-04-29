# @ifc-lite/mutations

Property editing and mutation tracking for IFClite. Edit IFC properties, quantities, and attributes in-place via an overlay pattern — original data stays read-only, changes export back to STEP. Supports undo / redo, change-set sharing, bulk updates, and CSV import.

## Installation

```bash
npm install @ifc-lite/mutations
```

## Edit a property

```typescript
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

const view = new MutablePropertyView(store.properties, 'arch-model');

const mutation = view.setProperty(
  wallExpressId,
  'Pset_WallCommon',
  'FireRating',
  'REI 120',
  PropertyValueType.Label,
);

console.log(`${mutation.oldValue} → ${mutation.newValue}`);

// Reads return the new value transparently
view.getPropertyValue(wallExpressId, 'Pset_WallCommon', 'FireRating'); // 'REI 120'
```

## Mutation history (for undo / export)

```typescript
const mutations = view.getMutations();
//   [{ id, type: 'UPDATE_PROPERTY', entityId, psetName, propName, oldValue, newValue, ... }]

console.log(view.hasChanges(wallExpressId));  // true
console.log(view.getModifiedEntityCount());   // 1
```

Reset back to the source data:

```typescript
view.clear();
```

## Bulk updates

```typescript
import { BulkQueryEngine } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

const engine = new BulkQueryEngine(store.entities, view);

const result = engine.execute({
  select: {
    entityTypes: [/* IfcWall enum value */],
    propertyFilters: [{
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      operator: '=',
      value: true,
    }],
  },
  action: {
    type: 'SET_PROPERTY',
    psetName: 'Pset_WallCommon',
    propName: 'ThermalTransmittance',
    value: 0.18,
    valueType: PropertyValueType.Real,
  },
});

console.log(`Updated ${result.affectedEntityCount} walls`);
```

Preview without applying:

```typescript
const preview = engine.preview(query);
console.log(`Would update ${preview.matchedCount} entities`);
```

## CSV import

Map a spreadsheet column to a pset/property in one call:

```typescript
import { CsvConnector } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

const connector = new CsvConnector(store.entities, view);

const stats = connector.import(csvText, {
  matchStrategy: { type: 'globalId', column: 'GlobalId' },
  propertyMappings: [
    { sourceColumn: 'Fire Rating', targetPset: 'Pset_WallCommon', targetProperty: 'FireRating', valueType: PropertyValueType.String },
    { sourceColumn: 'U-Value', targetPset: 'Pset_WallCommon', targetProperty: 'ThermalTransmittance', valueType: PropertyValueType.Real },
  ],
});

console.log(`Matched ${stats.matchedRows} / ${stats.totalRows} rows, applied ${stats.mutationsCreated} mutations`);
```

## Change sets — group + share

```typescript
import { ChangeSetManager } from '@ifc-lite/mutations';

const manager = new ChangeSetManager();
const changeSet = manager.createChangeSet('Fire safety pass — round 2');

manager.addMutation(mutation1);
manager.addMutation(mutation2);

const json = manager.exportChangeSet(changeSet.id);
// → ship to a teammate or persist to disk

const restored = manager.importChangeSet(json);
```

Pair this with `exportToStep(store, { applyMutations: true })` from `@ifc-lite/export` to write a real `.ifc` file with the changes baked in.

## API

See the [Property Editing Guide](../../docs/guide/mutations.md) and [API Reference](../../docs/api/typescript.md#ifc-litemutations).

## License

[MPL-2.0](../../LICENSE)
