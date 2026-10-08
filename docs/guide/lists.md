# Lists and Schedules

IFClite can turn model data into configurable property tables, the BIM equivalent of door schedules and wall schedules. The `@ifc-lite/lists` package evaluates a list definition against parsed model data and produces rows you can display, group, summarise, or export as CSV.

## How It Works

A **list definition** describes what to tabulate:

- **Entity types** - Which IFC classes to include (e.g. all `IfcDoor`)
- **Columns** - Which values to pull for each entity (attributes, properties, quantities, ...)
- **Filter groups** - Optional shared Rules predicates, evaluated by the viewer before column extraction

`executeList` runs a definition with empty filter groups against a **data provider** (an adapter over your parsed model) and returns a `ListResult` with one row per matching entity. See [migrating saved v1 conditions](#migrating-saved-v1-conditions) for Rules-backed definitions.

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
| `quantity` | Quantity from a qset | `Qto_WallBaseQuantities.NetSideArea` |
| `material` | Associated material names (joined with `", "`) | `Concrete, Insulation` |
| `classification` | Classification references (joined with `", "`) | `Uniclass Ss_25_10` |
| `spatial` | Containing spatial element name; `propertyName` picks the level (`Storey` (default), `Building`, `Site`, `Project`) | `Level 2` |
| `model` | Source file name | `office.ifc` |
| `zone` | Location-zone assignment and per-zone volume (user-defined 3D zone boxes, viewer-computed); `psetName` holds the zone-set id, `propertyName` picks the mode — see [Zone columns](#zone-columns) | `Section A` |

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

### Zone columns

`psetName` holds the **zone-set id** (durable; the set's display name is not unique). `propertyName` is the mode:

| Mode | Cell | Notes |
|------|------|-------|
| `Zone` (default) | Zone name | A straddling element shows every touched zone, joined with `", "`. |
| `Straddles` | Boolean | Whether the element crosses a zone boundary. |
| `volume (mesh)` | Number | The element's volume inside its HOME zone. Exported as `ZONE_MODE_VOLUME`. |
| `volume breakdown (mesh)` | Text | Every zone with a share, as `Zone A: 1.2, Zone B: 0.8`. Exported as `ZONE_MODE_BREAKDOWN`. |

Three things about the volume modes are load-bearing:

- **The basis is in the mode name.** `mesh` is the as-built geometry, *after* opening cuts — the only basis whose per-zone split is measured rather than inferred. It is not a `NetVolume` and not a `GrossVolume`; a zone volume derived from a net wall and one derived from a gross wall are not comparable, so the label travels with the number rather than living in a tooltip. The declared net/gross breakdowns are shown side by side in the viewer's properties panel, where there is room for all of them.
- **They are `null` until someone asks.** Apportionment is an explicit on-demand action, never part of model load, so adding the column never triggers a model-wide clip. A cell is also `null` when the element does not straddle, or when its mesh is not a proven closed solid — in which case no volume may be stated for it at all, let alone split.
- **The unit is the model's declared volume unit.** A `volume (mesh)` column is tagged with `QuantityType.Volume`, so the shared per-column unit resolver converts and labels it exactly like a declared `NetVolume`. Use `isZoneVolumeMode(mode)` rather than comparing strings if you need to make the same decision.

```typescript
import { ZONE_MODE_VOLUME, type ColumnDefinition } from '@ifc-lite/lists';

// `psetName` is the durable zone-set id, not the set's display name.
const zoneSetId = 'a3f1c0de-...';

const zoneVolume: ColumnDefinition = {
  id: 'zone-volume',
  source: 'zone',
  psetName: zoneSetId,
  propertyName: ZONE_MODE_VOLUME,
  label: 'Volume in zone',
};
```

A provider supplies the numbers through one optional method on `ListDataProvider`:

```typescript
import type { ListDataProvider } from '@ifc-lite/lists';

type ZoneVolumeShares = NonNullable<ListDataProvider['getZoneVolumeShares']>;
//   (expressId: number, zoneSetId: string) => {
//     homeValue: number | null;
//     shares: Array<{ zoneName: string; value: number }>;
//   } | null
```

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

`listResultToCSV` guards against spreadsheet formula injection (CWE-1236): a cell that starts with `=`, `+`, `-`, `@`, tab, or carriage return is prefixed with a single quote so Excel and Google Sheets treat it as text rather than a formula. The trigger is looked for past any leading invisible characters, so a zero-width space in front of `=` does not slip through.

One exception, deliberate: a cell that is **wholly** a number (`-0.35`, `+1`, `-1.5e-3`) is left alone, so a column of negative measures still sums in a spreadsheet. Such a cell cannot carry a formula, since the accepted characters are only `+ - . e E` and the digits. Anything with a trigger and a non-numeric tail (`-0.35=cmd`) is still prefixed. The consequence to know about is that a numeric-looking *identifier* held as text — a `+`-prefixed phone number, a zero-padded code like `-007` — is now written as a number rather than preserved as text.

Standard CSV quoting (double quotes, `""` escaping) is applied on top.

## Grouping, Aggregation & Schedules

Set `grouping` on a `ListDefinition` to bucket rows by one or more columns (outermost first) and sum numeric columns per group:

```typescript
import { executeList, summariseListRows, toScheduleRows, LIST_PRESETS } from '@ifc-lite/lists';

const definition = {
  ...LIST_PRESETS[0], // Wall Schedule
  grouping: {
    columnId: 'attr-name',       // legacy single-column field, kept in sync with columnIds[0]
    columnIds: ['attr-name'],    // ordered group-by columns, outermost first
    sumColumnIds: ['quant-qto_wallbasequantities-length'],
  },
};

const result = executeList(definition, provider);

// result.groups is a flat PRE-ORDER list: each parent group is immediately
// followed by its subgroups. Every group carries a Count aggregate (`count`)
// and per-column sums (`sums`).
for (const group of result.groups ?? []) {
  console.log(group.label, group.count, group.sums);
}

// A Bonsai-style schedule/pivot table — one row per group-value tuple (the
// LEAF groups only) instead of a nested tree. `levelCount` must be the number
// of grouping columns that were ACTUALLY applied: the engine drops grouping
// ids whose column is no longer in the definition (a stale persisted grouping
// is the common case), so passing the raw `columnIds.length` can ask for a
// deeper leaf level than the groups have — and `toScheduleRows` then matches
// nothing and returns no rows.
const activeGroupIds = definition.grouping.columnIds.filter(
  (id) => definition.columns.some((c) => c.id === id),
);
const scheduleRows = toScheduleRows(result.groups, activeGroupIds.length);
for (const row of scheduleRows) {
  console.log(row.path, row.count, row.sums); // e.g. ["Wall-01"], 1, { ... }
}
```

`summariseListRows(definition, rows)` is what `executeList` calls internally to build `groups`/`summary`; call it directly when you already have rows from elsewhere (e.g. merged across federated models) and just need to re-derive the grouping.

## Lists in documents

A list can be printed inside a [document](./documents.md): **Analyze → Document → Add block → Table (from a list)** takes a copy of a saved list or a preset and prints it the way the list's own export does — unit-converted cells, group rows with count and sums or the schedule view, a totals row when something is summed — re-running it on the loaded models whenever the document is shown or printed. The block's *Edit in Lists* opens the copy in the Lists panel; saving there and *Update from saved list* on the block brings the edit back. A copy never carries a search-selection snapshot (`expressIdsByModel`), which is bound to one load of one model.

## The Data Provider

`executeList` reads model data through the `ListDataProvider` interface, so the package has no hard dependency on how you parsed the model. Required methods include `getEntitiesByType`, `getEntityName`, `getEntityGlobalId`, `getPropertySets`, and `getQuantitySets`; optional methods (`getMaterialNames`, `getClassifications`, `getStoreyName`, `getProjectName`, `getZoneAssignment`, `getZoneSetNames`, `getZoneVolumeShares`, ...) unlock the `material`, `classification`, `spatial`, `model`, and `zone` column sources, and the engine degrades gracefully when they are absent (a `zone` column simply resolves to `null` on a provider without zone data). The two volume modes go through `getZoneVolumeShares` specifically, so a provider that implements `getZoneAssignment` but not `getZoneVolumeShares` still answers `Zone` and `Straddles` and returns `null` for the volumes.

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

## Migrating saved v1 conditions

`migrateLegacyListDefinition(definition)` converts a saved v1 definition's flat
`conditions`, and the provider-only rows lists saved before #6190, into
`groups: FilterGroup[]` before the viewer runs it. A plain property comparison
becomes a `property` rule; every other predicate becomes a `listCondition`
rule (see below), so no saved predicate changes the rows it keeps. Flat
conditions narrow every group: they are ANDed into each one, and an OR group is
split into one AND group per rule. The conversion is idempotent.

Only data no build can evaluate stays in `unreadableConditions`: a malformed
member, an unknown operator or source, or a saved rule this build does not
know. A saved list is not hidden because of one; the viewer shows each row
with a warning and a Remove button, and the list cannot run until they are
gone. `migrateLegacyListConditions(conditions)` exposes the pure condition
conversion for other v1 importers.

`executeList` is the synchronous provider-only source and column engine. First
evaluate any Rules groups, then pass an execution copy such as
`{ ...definition, groups: [], expressIdsByModel: filteredIdsByModel }`.
Passing the original definition with nonempty groups throws, even when it has
an `expressIdsByModel` snapshot, to avoid silently returning extra rows.

## Lists predicates inside Rules groups

A Lists value predicate with no canonical Rules equivalent (zone assignment and
zone volume modes, exact Container/Storey/Building/Site/Project levels,
quantity and material presence, the model file name, the Lists attributes such
as `Class`, `Type` and `GlobalId`, and properties inherited through
aggregation) can sit in a `FilterGroup` as a `listCondition` rule. Its fields
are the saved condition, verbatim, and the Lists engine answers it, so it keeps
the same rows it keeps as a list scope while composing with other rules under
AND or OR. Give each evaluated model the provider's matcher:

```ts
import { listConditionMatcher, type ListDataProvider } from '@ifc-lite/lists';
import { Rule, evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import type { IfcDataStore } from '@ifc-lite/parser';

declare const store: IfcDataStore;
declare const provider: ListDataProvider;

const straddlers = await evaluateFilterGroupsFederated(
  [{ id: 'm1', store, listConditions: listConditionMatcher(provider) }],
  [{ combinator: 'OR', rules: [
    Rule.listCondition({ source: 'zone', psetName: 'zone-set-id', propertyName: 'Straddles', operator: 'equals', value: 'true' }),
    Rule.name('eq', 'Core wall'),
  ] }],
);
```

## Key Exports

| Export | Description |
|--------|-------------|
| `executeList(definition, provider, modelId?)` | Run a list definition, returns `ListResult` |
| `listResultToCSV(result, delimiter?)` | CSV export with formula-injection guard |
| `summariseListRows` | Aggregate rows into group summaries (`ListGroup[]` + whole-result `ListSummary`) |
| `groupingColumnIds(grouping)` | Resolve a grouping config's ordered group-by column ids |
| `toScheduleRows(groups, levelCount)` | Project grouped `ListGroup[]` to a schedule/pivot `ListScheduleRow[]` — one row per group-value tuple |
| `discoverColumns(providers, entityTypes)` | Sample available attributes/properties/quantities |
| `compileNameMatcher(pattern)` / `isNamePattern(pattern)` | Exact-or-regex name matching |
| `migrateLegacyListConditions(conditions)` | Decode saved v1 conditions into one AND `FilterGroup` and explicit unreadable rows |
| `migrateLegacyListDefinition(definition)` | Normalize a saved v1 definition to the public `groups` shape |
| `listConditionMatcher(provider)` | The reader Rules' `listCondition` rules need on each evaluated model |
| `listConditionValueKind(source, propertyName)` | The kind of value the engine compares for a condition (number, boolean, text, several texts, or any), for offering matching operators |
| `LIST_PRESETS` | Built-in schedule definitions |
| `ENTITY_ATTRIBUTES` | The attribute names available to `attribute` columns |

See the [package README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/lists) and the type definitions (`ListDefinition`, `ColumnDefinition`, `PropertyCondition`, `ListDataProvider`) for the full API.

## Result source and coverage

The results header identifies the executed list and the models its native IFC
providers evaluated. It retains that identity when the current model picker or
model names change. Known targeted models without IFC table data are named as
coverage gaps; a stored result without recorded provenance reports an unknown
source rather than borrowing the current picker.

Matched entities and currently visible rows have separate counts. Search and
visibility filters keep the native result intact, and a filtered-empty table
is distinct from an explicit empty element scope. The viewer does not infer a
scanned-entity denominator from the match count. Nested and schedule tables use
the same result vocabulary, while their native grouping, units, selection and
exports remain available. Native run errors retain their existing error surface.
