# IFC-Lite + Three.js Example

IFC viewer using `@ifc-lite/geometry` + `@ifc-lite/parser` with Three.js — no WebGPU required.

**Features:** progressive streaming, vertex-color batching (1 draw call for opaque geometry), object picking, and a full IFC properties panel (attributes + property sets + quantities).

## How it works

The `@ifc-lite/geometry` package outputs engine-agnostic mesh data:

```typescript
interface MeshData {
  expressId: number;
  positions: Float32Array;  // [x,y,z, ...]
  normals: Float32Array;    // [nx,ny,nz, ...]
  indices: Uint32Array;     // triangle indices
  color: [r, g, b, a];     // RGBA 0-1
}
```

The `ifc-to-threejs.ts` bridge converts these into Three.js `BufferGeometry` + `MeshStandardMaterial`.

The `ifc-data.ts` module uses `@ifc-lite/parser` to scan the same buffer and build a columnar index for entity attributes and property set lookups.

## Quick start

```bash
npm install
npm run dev
```

> **Note:** `@ifc-lite/data` is listed as an explicit dependency here as a workaround —
> `@ifc-lite/geometry@1.11.0` uses it internally but omitted it from its own `dependencies`.
> It will be declared transitively in the next patch release and can be removed then.

Open `http://localhost:3000` and drop an IFC file. Click any element to see its IFC data in the side panel.

## Key files

| File | Purpose |
|------|---------|
| `src/main.ts` | Three.js scene setup, streaming loader, picking, panel wiring |
| `src/ifc-to-threejs.ts` | MeshData → Three.js conversion + triangle-map for picking |
| `src/ifc-data.ts` | `@ifc-lite/parser` wrapper — data store + entity attribute/pset queries |

## Integration patterns

### 1. One mesh per IFC entity (simple, good for picking)

```typescript
import { meshDataToThree } from './ifc-to-threejs';

const threeMesh = meshDataToThree(meshData);
scene.add(threeMesh);
```

### 2. Batched by color (fewer draw calls)

```typescript
import { geometryResultToBatched } from './ifc-to-threejs';

const { group, expressIdMap } = geometryResultToBatched(geometryResult);
scene.add(group);
```

### 3. Vertex-color batching with picking (best performance)

```typescript
import { batchWithVertexColors, findEntityByFace } from './ifc-to-threejs';

const { group, triangleMaps } = batchWithVertexColors(allMeshes);
scene.add(group);

// On click:
const hits = raycaster.intersectObjects([...triangleMaps.keys()], false);
if (hits[0]) {
  const ranges = triangleMaps.get(hits[0].object as THREE.Mesh);
  const expressId = findEntityByFace(ranges!, hits[0].faceIndex!);
}
```

### 4. Entity property data

```typescript
import { buildDataStore, getEntityData } from './ifc-data';

const store = await buildDataStore(rawBuffer);
const data = getEntityData(store, expressId, 'IfcWall');
// data.name, data.globalId, data.propertySets, data.quantitySets …
```

`getEntityData` returns: `globalId`, `name`, `description`, `objectType`, `tag`, `propertySets` (from `IfcPropertySet`), and `quantitySets` (from `IfcElementQuantity`).

### 5. Spatial hierarchy tree

```typescript
import { buildDataStore, buildSpatialTreeFromStore } from './ifc-data';

const store = await buildDataStore(rawBuffer);
const tree = buildSpatialTreeFromStore(store);
// tree: Project → Site → Building → Storey → Elements (grouped by IFC type)
// Each node: { children, elementGroups, elevation, totalElements }
```

Use `store.spatialHierarchy.elementToStorey.get(expressId)` for reverse lookup (element → storey), enabling two-way sync between the 3D view and spatial tree.

## License

MPL-2.0
