<table align="center">
<tr>
<td valign="top">
<h1>
<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=700&size=48&duration=2000&pause=5000&color=6366F1&vCenter=true&width=300&height=55&lines=IFClite" alt="IFClite">
</h1>
Open, view, and work with IFC files. Right in the browser.
</td>
<td width="120" align="center" valign="middle">
<img src="docs/assets/logo.png" alt="" width="100">
</td>
</tr>
</table>

<p align="center">
  <a href="https://www.ifclite.com/"><img src="https://img.shields.io/badge/🚀_Try_it_Live-ifclite.com-ff6b6b?style=for-the-badge&labelColor=1a1a2e" alt="Try it Live"></a>
</p>

<p align="center">
  <a href="https://github.com/louistrue/ifc-lite/actions"><img src="https://img.shields.io/github/actions/workflow/status/louistrue/ifc-lite/release.yml?branch=main&style=flat-square&logo=github" alt="Build Status"></a>
  <a href="https://github.com/louistrue/ifc-lite/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue?style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/@ifc-lite/parser"><img src="https://img.shields.io/npm/v/@ifc-lite/parser?style=flat-square&logo=npm&label=parser" alt="npm parser"></a>
  <a href="https://crates.io/crates/ifc-lite-core"><img src="https://img.shields.io/crates/v/ifc-lite-core?style=flat-square&logo=rust&label=core" alt="crates.io"></a>
</p>

---

# IFClite

Parse, view, query, edit, and export IFC files in the browser. Rust + WASM core, WebGPU rendering, ~260 KB gzipped, 5× faster geometry than the next best option.

Works with **IFC4 / IFC4X3** (876 entities, full schema) and **IFC5 (IFCX)**. Live demo at [ifclite.com](https://www.ifclite.com/).

## Get Started

```bash
npx create-ifc-lite my-viewer --template react
cd my-viewer && npm install && npm run dev
```

That gets you a working WebGPU IFC viewer with drag-and-drop, hierarchy, properties, and 2D drawings. Other templates: `basic`, `threejs`, `babylonjs`, `server`, `server-native`.

To add IFClite to an existing project:

```bash
npm install @ifc-lite/parser @ifc-lite/geometry @ifc-lite/renderer
```

## Parse an IFC file

```typescript
import { IfcParser } from '@ifc-lite/parser';

const parser = new IfcParser();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());
const result = await parser.parse(buffer, {
  onProgress: ({ phase, percent }) => console.log(`${phase}: ${percent}%`),
});

console.log(`Parsed ${result.entityCount} entities in ${result.parseTime}ms`);
```

For columnar storage (recommended for large models — TypedArray-backed, query-friendly):

```typescript
const store = await parser.parseColumnar(buffer);
console.log(`${store.entityCount} entities, schema ${store.schemaVersion}`);
```

## View in 3D

```typescript
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';

const parser = new IfcParser();
const geometry = new GeometryProcessor();
const renderer = new Renderer(canvas);

await Promise.all([geometry.init(), renderer.init()]);

const buffer = new Uint8Array(await file.arrayBuffer());
const parseResult = await parser.parse(buffer);
const meshes = await geometry.process(buffer);

renderer.loadGeometry(meshes);
renderer.requestRender();

// Pick an entity at (x, y) in canvas pixels
const hit = await renderer.pick(120, 240);
if (hit) console.log(`Picked expressId ${hit.expressId}`);
```

For Three.js or Babylon.js, parse + extract geometry the same way and feed `meshes` to your engine. See [Three.js integration](docs/tutorials/threejs-integration.md) and [Babylon.js integration](docs/tutorials/babylonjs-integration.md).

## Query entities

```typescript
import { IfcQuery } from '@ifc-lite/query';

const query = new IfcQuery(store);

// All external load-bearing walls
const walls = query
  .ofType('IfcWall', 'IfcWallStandardCase')
  .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
  .whereProperty('Pset_WallCommon', 'LoadBearing', '=', true)
  .execute();

console.log(`${walls.length} external load-bearing walls`);

for (const wall of walls) {
  console.log(wall.name, wall.globalId);
}
```

For more complex queries, use SQL via DuckDB-WASM:

```typescript
const result = await query.sql(`
  SELECT type, COUNT(*) AS n FROM entities GROUP BY type ORDER BY n DESC LIMIT 10
`);
console.table(result.rows);
```

## Validate against IDS

```typescript
import { parseIDS, validateIDS, createTranslationService } from '@ifc-lite/ids';

const idsSpec = parseIDS(idsXmlContent);
const translator = createTranslationService('en');
const report = await validateIDS(idsSpec, store, { translator });

for (const spec of report.specificationResults) {
  console.log(`${spec.specificationName}: ${spec.passRate}% passed`);
}
```

## Edit properties (with undo)

```typescript
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

const view = new MutablePropertyView(store.properties, 'my-model');

view.setProperty(
  wallExpressId,
  'Pset_WallCommon',
  'FireRating',
  'REI 120',
  PropertyValueType.Label,
);

console.log(view.getMutations()); // change history for undo / export
```

## Export

```typescript
import { exportToStep, GLTFExporter, ParquetExporter, Ifc5Exporter } from '@ifc-lite/export';

// IFC STEP — applies any pending mutations
const stepText = exportToStep(store, { schema: 'IFC4', applyMutations: true });

// glTF for the web
const glb = await new GLTFExporter().export(parseResult, { format: 'glb' });

// Parquet — columnar, ~20× smaller than JSON, queryable from DuckDB / Polars
const parquet = await new ParquetExporter().exportEntities(parseResult);

// IFC5 / IFCX — JSON + USD geometry
const ifcx = new Ifc5Exporter(store, meshes).export({ includeGeometry: true });
```

## Choose your setup

| Setup | Best for | You get |
|-------|----------|---------|
| [**Browser (WebGPU)**](docs/guide/quickstart.md) | Viewing and inspecting models | Full-featured 3D viewer, runs entirely client-side |
| [**Three.js / Babylon.js**](docs/tutorials/threejs-integration.md) | Adding IFC support to an existing 3D app | IFC parsing + geometry, rendered by your engine |
| [**Server**](docs/guide/server.md) | Teams, large files, repeat access | Rust backend with caching, parallel processing, streaming |
| [**Desktop (Tauri)**](docs/guide/desktop.md) | Offline use, very large files (500 MB+) | Native app with multi-threading and direct filesystem access |

Not sure? Start with the browser setup. You can add a server or switch engines later.

## Pick your packages

| I want to... | Packages |
|--------------|----------|
| Parse an IFC file | `@ifc-lite/parser` |
| View a 3D model (WebGPU) | + `@ifc-lite/geometry` + `@ifc-lite/renderer` |
| Use Three.js or Babylon.js | + `@ifc-lite/geometry` (you handle the rendering) |
| Query properties and types | + `@ifc-lite/query` |
| Edit properties (with undo) | + `@ifc-lite/mutations` |
| Validate against IDS rules | + `@ifc-lite/ids` |
| Generate 2D drawings | + `@ifc-lite/drawing-2d` |
| Create IFC files from scratch | `@ifc-lite/create` |
| Export to glTF / IFC / Parquet | + `@ifc-lite/export` |
| Connect to a server backend | + `@ifc-lite/server-client` |
| BCF issue tracking | + `@ifc-lite/bcf` |

Full list: [API Reference](docs/api/typescript.md) (25 TypeScript packages, 4 Rust crates).

## Performance

- **First triangles:** 200–500ms for a typical 50 MB model in the browser.
- **Geometry processing:** up to 5× faster than `web-ifc` on the same hardware.
- **Bundle size:** ~260 KB gzipped (parser + geometry + renderer).
- **Schema coverage:** 100% of IFC4 (776 entities) and IFC4X3 (876 entities).
- **Parse throughput:** ~1,259 MB/s tokenization on a typical M1 / M2 laptop.

See [benchmarks](docs/guide/performance.md) for full numbers across model sizes and hardware.

## Examples

Ready-to-run projects in [`examples/`](examples/):

- [**Three.js Viewer**](examples/threejs-viewer/) — IFC viewer using Three.js (WebGL)
- [**Babylon.js Viewer**](examples/babylonjs-viewer/) — IFC viewer using Babylon.js (WebGL)

## Documentation

| | |
|---|---|
| **Start here** | [Quick Start](docs/guide/quickstart.md) · [Installation](docs/guide/installation.md) · [Browser Requirements](docs/guide/browser-requirements.md) |
| **Guides** | [Parsing](docs/guide/parsing.md) · [Geometry](docs/guide/geometry.md) · [Rendering](docs/guide/rendering.md) · [Querying](docs/guide/querying.md) · [Exporting](docs/guide/exporting.md) |
| **BIM features** | [Federation](docs/guide/federation.md) · [BCF](docs/guide/bcf.md) · [IDS Validation](docs/guide/ids.md) · [bSDD](docs/guide/bsdd.md) · [2D Drawings](docs/guide/drawing-2d.md) · [IFC Creation](docs/guide/creation.md) · [Property Editing](docs/guide/mutations.md) |
| **Tutorials** | [Build a Viewer](docs/tutorials/building-viewer.md) · [Three.js](docs/tutorials/threejs-integration.md) · [Babylon.js](docs/tutorials/babylonjs-integration.md) · [Custom Queries](docs/tutorials/custom-queries.md) |
| **Deep dives** | [Architecture](docs/architecture/overview.md) · [Data Flow](docs/architecture/data-flow.md) · [Performance](docs/guide/performance.md) |
| **API** | [TypeScript](docs/api/typescript.md) · [Rust](docs/api/rust.md) · [WASM](docs/api/wasm.md) |

## Contributing

No Rust toolchain needed — WASM comes pre-built.

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/louistrue/ifc-lite.git
cd ifc-lite
pnpm install && pnpm build && pnpm dev   # opens viewer at localhost:5173
```

For benchmark fixtures, fetch only what you need:

```bash
git lfs pull --include="tests/models/ara3d/AC20-FZK-Haus.ifc"
```

See the [Contributing Guide](docs/contributing/setup.md) and [Release Process](RELEASE.md).

## Community

- [GitHub Discussions](https://github.com/louistrue/ifc-lite/discussions) — questions, ideas, show-and-tell
- [Issues](https://github.com/louistrue/ifc-lite/issues) — bug reports and feature requests
- [Releases](https://github.com/louistrue/ifc-lite/releases) — changelog and version notes

## License

[MPL-2.0](LICENSE) — use, modify, redistribute. Source files modified under MPL must remain MPL.
