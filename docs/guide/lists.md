# Lists and Schedules

IFClite can turn model data into configurable property tables, the BIM equivalent of door schedules and wall schedules. The `@ifc-lite/lists` package evaluates a list definition against parsed model data and produces rows you can display, group, summarise, or export as CSV.

## How It Works

A **list definition** describes what to tabulate:

- **Entity types** - Which IFC classes to include (e.g. all `IfcDoor`)
- **Columns** - Which values to pull for each entity (attributes, properties, quantities, ...)
- **Conditions** - Optional filters on property values

`executeList` runs the definition against a **data provider** (an adapter over your parsed model) and returns a `ListResult` with one row per matching entity.

## Quick Start

```typescript
import { executeList, listResultToCSV, LIST_PRESETS } from '@ifc-lite/lists';
import type { ListDataProvider } from '@ifc-lite/lists';

// LIST_PRESETS[0] is the Wall Schedule
const result = executeList(LIST_PRESETS[0], provider);

console.log(`${result.rows.length} walls`);

// Export as CSV
const csv = listResultToCSV(result);
```

`executeList(definition, provider, modelId?)` takes an optional third argument tagging rows with a model id (defaults to `'default'`), useful when running the same list across multiple loaded models.

## Column Sources

Each `ColumnDefinition` has a `source` that says where the value comes from:

| Source | Description | Example |
|--------|-------------|---------|
| `attribute` | Direct IFC attribute | `Name`, `GlobalId`, `ObjectType`, `Class` |
| `property` | Property from a pset | `Pset_WallCommon.FireRating` |
| `quantity` | Quantity from a qset | `Qto_WallBaseQuantities.NetArea` |
| `material` | Associated material names (joined with `", "`) | `Concrete, Insulation` |
| `classification` | Classification references (joined with `", "`) | `Uniclass Ss_25_10` |
| `spatial` | Containing spatial element name; `propertyName` picks the level (`Storey` (default), `Building`, `Site`, `Project`) | `Level 2` |
| `model` | Source file name | `office.ifc` |

A column looks like:

```typescript
import type { ColumnDefinition } from '@ifc-lite/lists';

const fireRating: ColumnDefinition = {
  id: 'prop-pset_doorcommon-firerating',
  source: 'property',
  psetName: 'Pset_DoorCommon',
  propertyName: 'FireRating',
  label: 'FireRating',
};
```

For `quantity` columns, `psetName` holds the quantity set name (e.g. `Qto_DoorBaseQuantities`).

## Built-in Presets

`LIST_PRESETS` is an array of ready-made `ListDefinition`s:

| Preset | Entity types | Columns |
|--------|--------------|---------|
| **Wall Schedule** | IfcWall, IfcWallStandardCase | Common properties and base quantities |
| **Door Schedule** | IfcDoor | FireRating, IsExternal, AcousticRating, Width, Height, Area |
| **Window Schedule** | IfcWindow | Dimensions |
| **Space Areas** | IfcSpace | Areas and volumes |
| **Zones & Systems** | IfcSpatialZone, IfcZone, IfcSystem, IfcDistributionSystem | Names |
| **All Elements** | Walls, doors, windows, slabs, columns, beams, stairs, roofs, coverings, curtain walls, railings | Overview columns |

## Worked Example: Door Schedule to CSV

```typescript
import { executeList, listResultToCSV, LIST_PRESETS } from '@ifc-lite/lists';

// LIST_PRESETS[1] is the Door Schedule:
//   Name, Class, ObjectType,
//   Pset_DoorCommon.FireRating / IsExternal / AcousticRating,
//   Qto_DoorBaseQuantities.Width / Height / Area
const doorSchedule = LIST_PRESETS[1];

const result = executeList(doorSchedule, provider, 'office.ifc');

for (const row of result.rows) {
  console.log(row.values);
}

const csv = listResultToCSV(result);
// listResultToCSV(result, delimiter?) - default delimiter is ','
```

### CSV Safety

`listResultToCSV` guards against spreadsheet formula injection (CWE-1236): any cell that starts with `=`, `+`, `-`, `@`, tab, or carriage return is prefixed with a single quote so Excel and Google Sheets treat it as text rather than a formula. Standard CSV quoting (double quotes, `""` escaping) is applied on top.

## The Data Provider

`executeList` reads model data through the `ListDataProvider` interface, so the package has no hard dependency on how you parsed the model. Required methods include `getEntitiesByType`, `getEntityName`, `getEntityGlobalId`, `getPropertySets`, and `getQuantitySets`; optional methods (`getMaterialNames`, `getClassifications`, `getStoreyName`, `getProjectName`, ...) unlock the `material`, `classification`, `spatial`, and `model` column sources, and the engine degrades gracefully when they are absent.

## Discovering Columns

To build a column picker UI (or just see what a model contains), use `discoverColumns`:

```typescript
import { discoverColumns } from '@ifc-lite/lists';
import { IfcTypeEnum } from '@ifc-lite/data';

// Accepts one provider or an array of providers
const discovered = discoverColumns(provider, [IfcTypeEnum.IfcDoor]);

discovered.attributes;  // available entity attributes
discovered.properties;  // Map<psetName, propertyNames[]>
discovered.quantities;  // Map<qsetName, quantityNames[]>
```

It samples up to 50 entities per type per provider, so it stays fast on large models.

## Name Patterns

Conditions and lookups that match by name accept either an exact string or a regex literal. `compileNameMatcher(pattern)` returns a `(name: string) => boolean`:

- `/fire.*rating/i` - a `/body/flags` string compiles to a regular expression
- anything else - exact, case-sensitive match

`isNamePattern(pattern)` tells you whether a string will be treated as a regex.

## Key Exports

| Export | Description |
|--------|-------------|
| `executeList(definition, provider, modelId?)` | Run a list definition, returns `ListResult` |
| `listResultToCSV(result, delimiter?)` | CSV export with formula-injection guard |
| `summariseListRows` | Aggregate rows into group summaries |
| `discoverColumns(providers, entityTypes)` | Sample available attributes/properties/quantities |
| `compileNameMatcher(pattern)` / `isNamePattern(pattern)` | Exact-or-regex name matching |
| `LIST_PRESETS` | Built-in schedule definitions |
| `ENTITY_ATTRIBUTES` | The attribute names available to `attribute` columns |

See the [package README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/lists) and the type definitions (`ListDefinition`, `ColumnDefinition`, `PropertyCondition`, `ListDataProvider`) for the full API.
