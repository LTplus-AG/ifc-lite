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

Open `http://localhost:5173`, then pick an IFC file with the file input or
drag-and-drop one anywhere on the page. Click any element to see its IFC data
in the side panel.

`npm run build` typechecks and writes a production bundle to `dist/`
(`npm run preview` serves it); `npm run typecheck` runs `tsc` alone.

Inside the monorepo it builds against the local `@ifc-lite/*` sources
(`workspace:*`), so it can never drift behind the packages it demonstrates. To
use it on its own, copy the folder out and replace each `workspace:*` with the
published version (`npm view @ifc-lite/parser version`), or start from
`npx create-ifc-lite` instead.

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
