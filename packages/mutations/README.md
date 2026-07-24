# @ifc-lite/mutations

Property editing and mutation tracking for IFClite. Edit IFC properties, quantities, and attributes in-place via an overlay pattern — original data stays read-only, changes export back to STEP. Supports undo / redo, change-set sharing, bulk updates, and CSV import.

## Installation

```bash
npm install @ifc-lite/mutations
```

## Edit a property

### Property edits

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

### Store-level edits

For raw STEP edits — adding entities, deleting them, overriding positional
arguments on entities without symbolic attribute names — pair the view with
a `StoreEditor`:

```typescript
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

const view = new MutablePropertyView(propertyTable, modelId);
const editor = new StoreEditor(dataStore, view);

// Add a fresh entity (e.g. an IfcRectangleProfileDef)
const profile = editor.addEntity('IfcRectangleProfileDef', [
  '.AREA.', null, '#34', 0.6, 0.4,
]);

// Override a single positional STEP arg by index (zero-based)
editor.setPositionalAttribute(profile.expressId, 3, 0.7);  // XDim → 0.7

// Tombstone an entity
editor.removeEntity(unwantedExpressId);
```

Edits accumulate in the same overlay used by `setProperty` / `setAttribute`
and materialise the next time you call
`StepExporter.export({ applyMutations: true })`.

### Whole numbers on REAL-typed attributes

ISO 10303-21 requires a REAL-typed attribute (`IfcLengthMeasure` coordinates,
profile dimensions, `IfcExtrudedAreaSolid.Depth`, …) to carry a decimal point —
`450.`, never `450`. The exporter is schema-aware: when a slot's declared type
is unambiguously REAL-backed, a whole-number value is serialized with the
decimal point automatically, so the natural call just works:

```typescript
editor.setPositionalAttribute(profile.expressId, 3, 1);  // XDim → 1.  (dotted)
```

For the rare slot that a bare value genuinely can't disambiguate — a
`SELECT(IfcInteger, IfcReal)` where you specifically want the REAL member — wrap
the number in the write-only `{ real }` marker to force a REAL literal:

```typescript
editor.addEntity('IfcQuantityLength', ['L', null, unitRef, { real: 3 }]); // → IFCLENGTHMEASURE-safe 3.
```

### Type-qualified values on SELECT attributes

ISO 10303-21 requires a SELECT member that is a defined type to be
type-QUALIFIED — `IFCBOOLEAN(.T.)`, not a bare `.T.`, in an
`IfcTranslationalStiffnessSelect` slot. The exporter auto-qualifies these when
the member is unambiguous, so the natural call just works:

```typescript
// TranslationalStiffnessX : SELECT(IfcBoolean, IfcLinearStiffnessMeasure)
editor.setPositionalAttribute(condition.expressId, 1, true);  // → IFCBOOLEAN(.T.)
editor.setPositionalAttribute(condition.expressId, 1, 1000);  // → IFCLINEARSTIFFNESSMEASURE(1000.)
```

When the SELECT has several members of the same primitive class (a number in
`IfcValue`, which has 100+ REAL-backed members) auto-qualification can't choose.
Use the write-only `{ typed: { type, value } }` marker to pin the exact type —
it also works for the whole `IfcValue` family (`NominalValue`, etc.) and
subsumes `{ real }`:

```typescript
// IfcPropertySingleValue: Name, Description, NominalValue (IfcValue), Unit
editor.addEntity('IfcPropertySingleValue', [
  'Length', null, { typed: { type: 'IfcLengthMeasure', value: 3 } }, null,
]); // NominalValue → IFCLENGTHMEASURE(3.)
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

See the [Property Editing Guide](https://ifclite.dev/docs/guide/mutations/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-litemutations).

## License

[MPL-2.0](../../LICENSE)
