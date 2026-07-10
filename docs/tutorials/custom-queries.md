# Custom Queries

Learn to build powerful queries with IFClite.

## Query Basics

```mermaid
flowchart LR
    Start["Query Builder"]
    Filter1["Type Filter"]
    Filter2["Property Filter"]
    Filter3["Spatial Filter"]
    Output["Results"]

    Start --> Filter1 --> Filter2 --> Filter3 --> Output
```

## Fluent API Examples

### Basic Type Queries

```typescript
import { IfcQuery } from '@ifc-lite/query';

const query = new IfcQuery(store); // store from parseColumnar()

// Get all walls
const walls = query.walls().execute();

// Get all doors and windows
const openings = query
  .ofType('IFCDOOR', 'IFCWINDOW')
  .execute();

// Get only standard walls
const standardWalls = query
  .ofType('IFCWALLSTANDARDCASE')
  .execute();
```

### Property Filters

```typescript
// External walls only
const externalWalls = query
  .walls()
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .execute();

// Walls with fire rating >= 60 minutes
const fireRatedWalls = query
  .walls()
  .whereProperty('Pset_WallCommon', 'FireRating', '>=', 60)
  .execute();

// Load-bearing walls
const loadBearing = query
  .walls()
  .whereProperty('Pset_WallCommon', 'LoadBearing', '=', true)
  .execute();

// Combine multiple filters
const criticalWalls = query
  .walls()
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .whereProperty('Pset_WallCommon', 'FireRating', '>=', 90)
  .whereProperty('Pset_WallCommon', 'LoadBearing', '=', true)
  .execute();
```

### Quantity Filters

`EntityQuery` has no quantity filter. Read quantities per entity via the
graph API (`EntityNode.quantities()`) and filter in JavaScript.

```typescript
function quantityValue(q: IfcQuery, expressId: number, name: string): number | null {
  for (const qset of q.entity(expressId).quantities()) {
    const found = qset.quantities.find(x => x.name === name);
    if (found) return found.value;
  }
  return null;
}

// Large walls by area (> 20 m2)
const largeWalls = query
  .walls()
  .execute()
  .filter(w => (quantityValue(query, w.expressId, 'NetArea') ?? 0) > 20);

// Thick slabs (>= 300mm)
const thickSlabs = query
  .slabs()
  .execute()
  .filter(s => (quantityValue(query, s.expressId, 'Thickness') ?? 0) >= 0.3);
```

### Spatial Queries

Spatial queries are keyed by numeric express id. `query.storeys` returns the
storey nodes (sorted by elevation), `onStorey(storeyId)` returns the elements
contained on that storey, and `inBounds(aabb)` queries by a bounding box.

```typescript
// Get all elements on ground floor (find the storey node by name first)
const groundFloor = query.storeys.find(s => s.name === 'Ground Floor');
const groundFloorElements = groundFloor
  ? query.onStorey(groundFloor.expressId).execute()
  : [];

// Get elements within a bounding box (requires processed geometry)
const buildingElements = query
  .inBounds({ min: [0, 0, 0], max: [100, 100, 30] })
  .execute();

// Get spaces on a specific storey (filter the results by type)
const level1 = query.storeys.find(s => s.name === 'Level 1');
const storeySpaces = level1
  ? query.onStorey(level1.expressId).execute().filter(e => e.type === 'IfcSpace')
  : [];
```

### Relationship Traversal

The graph API (`query.entity(id)`) returns an `EntityNode`. Traversal methods
return `EntityNode` or `EntityNode[]` directly (no terminal call).

```typescript
// Get the openings (voids) cut into a wall
const wallOpenings = query
  .entity(wallId)
  .voids();

// Get the elements contained in a space
const spaceElements = query
  .entity(spaceId)
  .contains();

// Find what contains this element (returns an EntityNode or null)
const container = query
  .entity(elementId)
  .containedIn();
```

## Building Complex Queries

### Query Composition

```typescript
import { EntityQuery } from '@ifc-lite/query';

// Create reusable query parts
function externalElements(q: EntityQuery): EntityQuery {
  return q.whereProperty('Pset_WallCommon', 'IsExternal', '=', true);
}

function fireRated(q: EntityQuery, rating: number): EntityQuery {
  return q.whereProperty('Pset_WallCommon', 'FireRating', '>=', rating);
}

// Compose queries
const externalFireRatedWalls = fireRated(
  externalElements(query.walls()),
  60
).execute();
```

### Query Unions

```typescript
// Combine results from multiple queries
const structuralElements = [
  ...query.walls().whereProperty('Pset_WallCommon', 'LoadBearing', '=', true).execute(),
  ...query.columns().execute(),
  ...query.beams().execute(),
  ...query.slabs().execute()
];
```

### Exclusion Patterns

```typescript
// All elements except spaces and openings
const physicalElements = query
  .all()
  .execute()
  .filter(e =>
    e.type !== 'IfcSpace' &&
    e.type !== 'IfcOpeningElement'
  );
```

## SQL Queries

For complex analytics, use SQL:

```typescript
// sql() lazily initializes DuckDB on the first call - no enable step needed,
// but @duckdb/duckdb-wasm must be installed or sql() throws.
// Simple aggregation
const wallCounts = await query.sql(`
  SELECT type, COUNT(*) as count
  FROM entities
  WHERE type LIKE 'IfcWall%'
  GROUP BY type
`);

// Join with properties
const wallsWithFireRating = await query.sql(`
  SELECT
    e.express_id,
    e.name,
    p.value_real as fire_rating
  FROM entities e
  JOIN properties p ON e.express_id = p.entity_id
  WHERE e.type LIKE 'IfcWall%'
    AND p.pset_name = 'Pset_WallCommon'
    AND p.prop_name = 'FireRating'
`);

// Complex analysis
const floorAreaByStorey = await query.sql(`
  WITH storey_spaces AS (
    SELECT
      s.express_id as storey_id,
      s.name as storey_name,
      e.express_id as space_id
    FROM entities s
    JOIN relationships r ON s.express_id = r.source_id
    JOIN entities e ON r.target_id = e.express_id
    WHERE s.type = 'IfcBuildingStorey'
      AND e.type = 'IfcSpace'
      AND r.rel_type = 'ContainsElements'
  )
  SELECT
    ss.storey_name,
    SUM(q.value) as total_area
  FROM storey_spaces ss
  JOIN quantities q ON ss.space_id = q.entity_id
  WHERE q.quantity_name = 'NetFloorArea'
  GROUP BY ss.storey_name
  ORDER BY total_area DESC
`);
```

## Visualization Integration

### Color by Query

!!! note "Color Support"
    Dynamic per-entity coloring is not yet supported in the public API.
    This example shows the concept - actual implementation requires extending the renderer.

```typescript
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { IfcQuery } from '@ifc-lite/query';

// First, parse the IFC file to get store and buffer
const parser = new IfcParser();
const response = await fetch('model.ifc');
const buffer = new Uint8Array(await response.arrayBuffer());
const store = await parser.parseColumnar(buffer.buffer);

// Create query from parsed store
const query = new IfcQuery(store);

// Get walls and their fire ratings
const walls = query.walls().execute();

// Create color map based on fire rating
const colorMap = new Map<number, string>();

for (const wall of walls) {
  // Extract properties on-demand from the parsed store (returns an array of psets)
  const psets = extractPropertiesOnDemand(store, wall.expressId);
  const wallCommon = psets.find(p => p.name === 'Pset_WallCommon');
  const fireRatingProp = wallCommon?.properties.find(p => p.name === 'FireRating');
  const fireRating = typeof fireRatingProp?.value === 'number' ? fireRatingProp.value : 0;

  if (fireRating >= 90) {
    colorMap.set(wall.expressId, 'red');
  } else if (fireRating >= 60) {
    colorMap.set(wall.expressId, 'orange');
  } else if (fireRating >= 30) {
    colorMap.set(wall.expressId, 'yellow');
  }
}

console.log('Fire rating analysis:', colorMap);
```

### Isolate Query Results

```typescript
// Isolate external walls (show only these)
const externalWalls = query
  .walls()
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .execute();

const isolatedIds = new Set(externalWalls.map(w => w.expressId));
renderer.render({ isolatedIds });
```

### Selection from Query

```typescript
// Select all fire-rated walls
const fireRated = query
  .walls()
  .whereProperty('Pset_WallCommon', 'FireRating', '>', 0)
  .execute();

const selectedIds = new Set(fireRated.map(e => e.expressId));
renderer.render({ selectedIds });
```

## Performance Tips

### 1. Filter Early

```typescript
// Good: filter by type first
const result = query
  .walls()  // Narrow down first
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .execute();

// Bad: property-filter across every entity instead of narrowing by type first
// (EntityQuery has no .ofType(); type filtering must come from IfcQuery, e.g. query.walls())
const allExternal = query
  .all()
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .execute();
```

### 2. Use Count for Checks

<!-- docs-check: skip -->
```typescript
// Good: just check count (count() is async, so await it)
const hasExternalWalls = (await query
  .walls()
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .count()) > 0;

// Bad: get all results just to check existence
const externalWalls = query
  .walls()
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .execute();
const hasExternalWalls = externalWalls.length > 0;
```

### 3. Use SQL for Complex Analytics

```typescript
// For simple queries: Fluent API
const walls = query.walls().execute();

// For aggregations: SQL
const stats = await query.sql(`
  SELECT type, COUNT(*), AVG(quantity) ...
`);
```

## Next Steps

- [Extending the Parser](extending-parser.md) - Custom processing
- [API Reference](../api/typescript.md) - Query API
