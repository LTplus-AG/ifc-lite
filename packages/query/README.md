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
  console.log(wall.properties()); // lazily-loaded psets
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
  .whereProperty('Pset_WallCommon', 'FireRating', '!=', null)
  .execute();
```

Supported: `=`, `!=`, `>`, `<`, `>=`, `<=`, `CONTAINS`, `STARTS_WITH`, `IS_NULL`, `IS_NOT_NULL`.

## Graph traversal

```typescript
const wall = query.entity(12345);

// Walk the spatial structure
console.log(wall.storey()?.name);    // 'Ground Floor'
console.log(wall.building()?.name);  // 'Office Tower'

// Containment + composition
const openings = wall.contains(); // openings hosted by the wall
const aggregates = wall.composedOf();
```

## SQL via DuckDB-WASM

```typescript
const result = await query.sql(`
  SELECT type, COUNT(*) AS count, AVG(volume) AS avg_volume
  FROM entities e
  JOIN quantities q ON q.entity_id = e.express_id
  WHERE q.name = 'NetVolume'
  GROUP BY type
  ORDER BY count DESC
  LIMIT 10
`);

console.table(result.rows);
```

Tables exposed: `entities`, `properties`, `quantities`, `relationships`. Useful when you'd rather write SQL than chain method calls.

## API

See the [Querying Guide](https://louistrue.github.io/ifc-lite/guide/querying/) and [API Reference](https://louistrue.github.io/ifc-lite/api/typescript/#ifc-litequery).

## License

[MPL-2.0](../../LICENSE)
