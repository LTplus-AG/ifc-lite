# @ifc-lite/query

Query system for IFClite. Fluent type-safe filtering of an `IfcDataStore`, plus full SQL via DuckDB-WASM. Filters by IFC type, property values, and relationships across multi-model federations.

## Installation

```bash
npm install @ifc-lite/query
```

## Fluent queries

```typescript
import { IfcQuery } from '@ifc-lite/query';

const query = new IfcQuery(store); // store from `parseColumnar()`

// All external load-bearing walls
const walls = query
  .ofType('IfcWall', 'IfcWallStandardCase')
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .whereProperty('Pset_WallCommon', 'LoadBearing', '=', true)
  .execute();

console.log(`${walls.length} external load-bearing walls`);

for (const wall of walls) {
  console.log(wall.name, wall.globalId);
  console.log(wall.properties); // lazily-loaded psets
}
```

Convenience methods for the common building elements:

```typescript
query.walls().execute();
query.doors().execute();
query.windows().execute();
query.slabs().execute();
query.columns().execute();
query.beams().execute();
query.spaces().execute();
```

## Comparison operators

```typescript
query
  .ofType('IfcWall')
  .whereProperty('Qto_WallBaseQuantities', 'NetVolume', '>', 5.0)
  .whereProperty('Pset_WallCommon', 'FireRating', 'startsWith', 'REI')
  .execute();
```

Supported: `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startsWith`. The first
argument names either a property set (`Pset_*`) or a quantity set (`Qto_*`).

Comparisons are same-type only — `'60'` does not match `60` — and a `null` on
either side never matches, including with `!=`. A filter matches when *any*
property of that name, in *any* set of that name, satisfies it.

On a STEP (`.ifc`) model the property sets are resolved lazily from the source
buffer rather than from a pre-built index, so `whereProperty` does work per
*candidate* entity. Narrow with `ofType(...)` / `onStorey(...)` before filtering:
`query.all().whereProperty(...)` resolves every entity in the model and on a
large one costs many times the type-scoped form. A cache-restored `.ifc` model
behaves the same way: the cache stores the property table as it was built, and a
STEP parse leaves it empty. What decides the path is the store rather than the
file format — a query answers from the property index whenever the store carries
table rows. Both paths return the same entities.

## Graph traversal

```typescript
const wall = query.entity(12345);

// Walk the spatial structure
console.log(wall.storey()?.name);    // 'Ground Floor'
console.log(wall.building()?.name);  // 'Office Tower'

// Containment + composition
const openings = wall.voids();      // openings cut into the wall (IfcRelVoidsElement)
const contents = wall.storey()?.contains() ?? []; // elements in the wall's storey (IfcRelContainedInSpatialStructure)
const aggregates = wall.decomposes();
```

## Selector syntax

`parseSelector(text)` parses the IfcOpenShell selector syntax into an AST
(`{ ok: true, query }` or `{ ok: false, error }`).
`selectorToQueryDescriptor(text)` turns one selector group into
`{ types, filters }`. It throws `SelectorUnsupportedError`, naming each
construct, when part of the selector has no lossless translation (a `+`
union, `!` negation, `parent=…`, a regex set name), instead of running a
partial or empty filter.

```typescript
import { selectorToQueryDescriptor } from '@ifc-lite/query';

const { types, filters } = selectorToQueryDescriptor(
  'IfcWall, IfcSlab, Pset_WallCommon.FireRating=2HR, Qto_WallBaseQuantities.NetVolume>1',
);
// types   → ['IfcWall', 'IfcSlab']
// filters → [{ psetName: 'Pset_WallCommon', propName: 'FireRating', operator: '=', value: '2HR' }, …]
```

## SQL via DuckDB-WASM

```typescript
const result = await query.sql(`
  SELECT e.type, COUNT(*) AS count, AVG(q.value) AS avg_volume
  FROM entities e
  JOIN quantities q ON q.entity_id = e.express_id
  WHERE q.quantity_name = 'NetVolume'
  GROUP BY e.type
  ORDER BY count DESC
  LIMIT 10
`);

console.table(result.rows);
```

Tables exposed: `entities`, `properties`, `quantities`, `relationships`, plus the views `walls`, `doors`, `windows`, `slabs`, `columns`, `beams`, `spaces`, `entity_properties` and `entity_quantities`. Useful when you'd rather write SQL than chain method calls.

The `properties` and `quantities` tables are copied from the store's property and quantity tables. A STEP store from `parseColumnar()` leaves those empty and extracts property sets on demand, so on such a store the two tables (and any join on them, like the example above) return no rows; the fluent `whereProperty` and `properties` API is the way to read them. IFCX stores fill both tables.

DuckDB is loaded lazily on the first `sql()` call and is not bundled; its WASM bundle is fetched from jsDelivr (`getJsDelivrBundles`) at that point. To use the SQL API, install it alongside:

```bash
npm install @duckdb/duckdb-wasm
```

The fluent query API works without it.

## API

See the [Querying Guide](https://ifclite.dev/docs/guide/querying/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-litequery).

## License

[MPL-2.0](../../LICENSE)
