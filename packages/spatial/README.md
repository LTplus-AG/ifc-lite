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

// For very large models (50K+ meshes), use the time-sliced builder:
// it yields to the event loop between chunks so the UI stays responsive.
import { buildSpatialIndexAsync } from '@ifc-lite/spatial';
const indexAsync = await buildSpatialIndexAsync(meshes);
```

For precomputed boxes, `BVH.buildAsync(meshesWithBounds, budgetMs, yieldToEventLoop)`
builds the same queryable index. `budgetMs` is an approximate time budget between
checkpoints, not a hard maximum frame time. The caller supplies an async
`yieldToEventLoop` callback that actually schedules another browser task (for
example `scheduler.yield()` or a `MessageChannel` turn); an already-resolved
promise does not give the browser a chance to paint. If the callback rejects,
the build rejects and does not return a partial index. `buildSpatialIndexAsync`
supplies its own browser scheduler and defaults to a 4 ms budget.

## Raycast (entity picking)

```typescript
import { buildSpatialIndex } from '@ifc-lite/spatial';

const index = buildSpatialIndex(meshes);

const origin: [number, number, number] = [0, 5, 10];
const direction: [number, number, number] = [0, -1, 0];

const hits = index.raycast(origin, direction);
// → expressIds of meshes whose bounds intersect the ray; order is unspecified

console.log(`${hits.length} broad-phase candidates`);
```

## AABB query (region select)

```typescript
import { buildSpatialIndex, type AABB } from '@ifc-lite/spatial';

const index = buildSpatialIndex(meshes);

const region: AABB = {
  min: [-5, 0, -5],
  max: [5, 3, 5],
};

const hits = index.queryAABB(region);
// → expressIds of every mesh whose bounds intersect the box

console.log(`${hits.length} entities in region`);
```

## Frustum culling

```typescript
import { buildSpatialIndex, FrustumUtils } from '@ifc-lite/spatial';

const index = buildSpatialIndex(meshes);

// Your camera's view-projection matrix (column-major 4×4)
declare const viewProjMatrix: Float32Array;

const frustum = FrustumUtils.fromViewProjMatrix(viewProjMatrix);

const visible = index.queryFrustum(frustum);
// → expressIds visible to the camera; renderer only draws these
```

## When to use this

The renderer (`@ifc-lite/renderer`) ships its own GPU-side picking and culling — for typical use you don't need this package directly. Reach for `@ifc-lite/spatial` when you're:

- Building a custom renderer (Three.js, Babylon.js, custom WebGPU)
- Running CPU-side raycasts for measurements / snapping / hit-tests outside the GPU pipeline
- Doing offline analysis (e.g. server-side intersection tests)

## API

See the [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-litespatial).

## License

[MPL-2.0](../../LICENSE)
