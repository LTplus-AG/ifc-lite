# IFC-Lite + Babylon.js Example

IFC viewer using `@ifc-lite/geometry` + `@ifc-lite/parser` with Babylon.js.

**Features:** progressive geometry streaming, vertex-color batching, object
picking, a full IFC properties panel (attributes + property sets + quantities),
and a spatial hierarchy tree with two-way selection sync.

## How it works

1. Geometry streams progressively via `@ifc-lite/geometry` (WASM). Each batch is
   vertex-color-batched and added to the scene immediately.
2. On `complete`, the whole model is rebuilt as a single optimised mesh and the
   temporary batch groups are disposed one frame later (no visual pop).
3. In parallel, `@ifc-lite/parser` builds a columnar data store for entity
   attributes, property sets, and the spatial hierarchy tree.

The `ifc-to-babylon.ts` bridge converts engine-agnostic `MeshData` from
`@ifc-lite/geometry` into Babylon.js meshes. The `ifc-data.ts` module wraps
`@ifc-lite/parser` for entity attribute and property-set lookups.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and drop an IFC file. Click any element to see its
IFC data in the side panel.

## Key files

| File | Purpose |
|------|---------|
| `src/main.ts` | Babylon.js scene setup, streaming loader, picking, panel wiring |
| `src/ifc-to-babylon.ts` | `MeshData` -> Babylon.js conversion + triangle-map for picking |
| `src/ifc-data.ts` | `@ifc-lite/parser` wrapper - data store + entity attribute/pset queries |

## Tutorial

For a step-by-step walkthrough, see the
[Babylon.js integration tutorial](https://ifclite.dev/docs/tutorials/babylonjs-integration/).

## License

MPL-2.0
