# @ifc-lite/spatial

Spatial indexing for IFClite. Builds a BVH (Bounding Volume Hierarchy) over your meshes and serves three query primitives: AABB intersection, raycast, and frustum culling.

## Installation

```bash
npm install @ifc-lite/spatial
```

## Build an index

```typescript
import { buildSpatialIndex } from '@ifc-lite/spatial';

const index = buildSpatialIndex(meshes); // MeshData[] from @ifc-lite/geometry

// For very large models (50K+ meshes), build off the main thread:
import { buildSpatialIndexAsync } from '@ifc-lite/spatial';
const indexAsync = await buildSpatialIndexAsync(meshes);
```

## Raycast (entity picking)

```typescript
const origin: [number, number, number] = [0, 5, 10];
const direction: [number, number, number] = [0, -1, 0];

const hits = index.raycast(origin, direction);
// → expressIds of meshes the ray intersects, in hit order

if (hits.length > 0) {
  console.log(`First hit: expressId ${hits[0]}`);
}
```

## AABB query (region select)

```typescript
const region = {
  min: [-5, 0, -5],
  max: [5, 3, 5],
} as const;

const hits = index.queryAABB(region);
// → expressIds of every mesh whose bounds intersect the box

console.log(`${hits.length} entities in region`);
```

## Frustum culling

```typescript
import { FrustumUtils } from '@ifc-lite/spatial';

// Build a frustum from a view-projection matrix (column-major 4×4)
const frustum = FrustumUtils.fromMatrix(viewProjMatrix);

const visible = index.queryFrustum(frustum);
// → expressIds visible to the camera; renderer only draws these
```

## When to use this

The renderer (`@ifc-lite/renderer`) ships its own GPU-side picking and culling — for typical use you don't need this package directly. Reach for `@ifc-lite/spatial` when you're:

- Building a custom renderer (Three.js, Babylon.js, custom WebGPU)
- Running CPU-side raycasts for measurements / snapping / hit-tests outside the GPU pipeline
- Doing offline analysis (e.g. server-side intersection tests)

## API

See the [API Reference](https://louistrue.github.io/ifc-lite/api/typescript/#ifc-litespatial).

## License

[MPL-2.0](../../LICENSE)
