# @ifc-lite/renderer

WebGPU-based 3D renderer for IFClite. Zero-copy from WASM linear memory to GPU buffers, hardware frustum culling, GPU-accelerated picking, section planes, multi-model federation.

## Installation

```bash
npm install @ifc-lite/renderer
```

## Render an IFC model

```typescript
import { Renderer } from '@ifc-lite/renderer';
import { GeometryProcessor } from '@ifc-lite/geometry';

const renderer = new Renderer(canvas);
const geometry = new GeometryProcessor();
await Promise.all([renderer.init(), geometry.init()]);

const meshes = await geometry.process(new Uint8Array(buffer));
renderer.loadGeometry(meshes);
renderer.requestRender();
```

`loadGeometry()` accepts a `GeometryResult` from `@ifc-lite/geometry` or a raw `MeshData[]`. The renderer keeps geometry in GPU buffers; subsequent `requestRender()` calls coalesce into a single frame.

## Pick an entity

```typescript
canvas.addEventListener('click', async (e) => {
  const rect = canvas.getBoundingClientRect();
  const hit = await renderer.pick(e.clientX - rect.left, e.clientY - rect.top);

  if (hit) {
    console.log(`Clicked expressId ${hit.expressId} at`, hit.point);
    renderer.setSelection([hit.expressId]);
    renderer.requestRender();
  }
});
```

For exact world-space hits with surface normals, use `raycastScene(x, y)` — slower but returns the precise intersection point + normal.

## Section planes

```typescript
// Cut the model with an axis-aligned section plane
renderer.setSectionPlane({
  axis: 'down',          // 'side' | 'down' | 'front' (X / Y / Z)
  position: 3.0,         // metres along axis
  enabled: true,
  flipped: false,
});
renderer.requestRender();

// Disable
renderer.setSectionPlane(null);
```

## Visibility + colour overrides

```typescript
// Hide a list of entities
renderer.setHiddenEntities(new Set([12345, 12346, 12347]));

// Solo a subset (everything else gets the ghost treatment)
renderer.setIsolatedEntities(new Set([42]));

// Tint specific entities
renderer.setColorOverrides(new Map([
  [42, [1, 0, 0, 1]],   // RGBA — bright red
  [99, [0, 1, 0, 0.4]], // semi-transparent green
]));
renderer.requestRender();
```

## Multi-model federation

```typescript
import { federationRegistry } from '@ifc-lite/renderer';

// Register each model with a unique ID offset
federationRegistry.registerModel('arch', maxArchExpressId);
federationRegistry.registerModel('struct', maxStructExpressId);

// Now picks return globalIds; resolve back to (modelId, expressId)
const hit = await renderer.pick(x, y);
const { modelId, expressId } = federationRegistry.fromGlobalId(hit.expressId);
```

## API

See the [Rendering Guide](https://louistrue.github.io/ifc-lite/guide/rendering/) and [API Reference](https://louistrue.github.io/ifc-lite/api/typescript/#ifc-literenderer).

## License

[MPL-2.0](../../LICENSE)
