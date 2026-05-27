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
  <a href="https://github.com/LTplus-AG/ifc-lite/actions"><img src="https://img.shields.io/github/actions/workflow/status/LTplus-AG/ifc-lite/release.yml?branch=main&style=flat-square&logo=github" alt="Build Status"></a>
  <a href="https://github.com/LTplus-AG/ifc-lite/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue?style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/@ifc-lite/parser"><img src="https://img.shields.io/npm/v/@ifc-lite/parser?style=flat-square&logo=npm&label=parser" alt="npm parser"></a>
  <a href="https://crates.io/crates/ifc-lite-core"><img src="https://img.shields.io/crates/v/ifc-lite-core?style=flat-square&logo=rust&label=core" alt="crates.io"></a>
</p>

---

# IFClite

Parse, view, query, edit, and export IFC files in the browser. Rust + WASM core, WebGPU rendering, ~260 KB gzipped, 5× faster geometry than the next best option.

Works with **IFC2X3**, **IFC4 / IFC4X3** and **IFC5 (IFCX)**. Live demo at [ifclite.com](https://www.ifclite.com/) and more info here: [ifclite.dev](https://www.ifclite.dev/).

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
const t0 = performance.now();
const store = await parser.parseColumnar(buffer, {
  onProgress: ({ phase, percent }) => console.log(`${phase}: ${percent}%`),
});

console.log(`${store.entityCount} entities, schema ${store.schemaVersion}`);
console.log(`Parsed in ${(performance.now() - t0).toFixed(0)}ms`);
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

const arrayBuffer = await file.arrayBuffer();
const store = await parser.parseColumnar(arrayBuffer);
const meshes = [];
for await (const event of geometry.processAdaptive(new Uint8Array(arrayBuffer))) {
  if (event.type === 'batch') meshes.push(...event.meshes);
}

renderer.loadGeometry(meshes);
renderer.requestRender();

// Pick an entity at (x, y) in canvas pixels
const hit = await renderer.pick(120, 240);
if (hit) console.log(`Picked expressId ${hit.expressId}`);
```

For Three.js or Babylon.js, parse + extract geometry the same way and feed `meshes` to your engine. See [Three.js integration](https://ltplus-ag.github.io/ifc-lite/tutorials/threejs-integration/) and [Babylon.js integration](https://ltplus-ag.github.io/ifc-lite/tutorials/babylonjs-integration/).

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
| [**Browser (WebGPU)**](https://ltplus-ag.github.io/ifc-lite/guide/quickstart/) | Viewing and inspecting models | Full-featured 3D viewer, runs entirely client-side |
| [**Three.js / Babylon.js**](https://ltplus-ag.github.io/ifc-lite/tutorials/threejs-integration/) | Adding IFC support to an existing 3D app | IFC parsing + geometry, rendered by your engine |
| [**Server**](https://ltplus-ag.github.io/ifc-lite/guide/server/) | Teams, large files, repeat access | Rust backend with caching, parallel processing, streaming |
| [**Desktop (Tauri)**](https://ltplus-ag.github.io/ifc-lite/guide/desktop/) | Offline use, very large files (500 MB+) | Native app with multi-threading and direct filesystem access |

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

Full list: [API Reference](https://ltplus-ag.github.io/ifc-lite/api/typescript/) (25 TypeScript packages, 4 Rust crates).

## Performance

- **First triangles:** 200–500ms for a typical 50 MB model in the browser.
- **Geometry processing:** up to 5× faster than `web-ifc` on the same hardware.
- **Bundle size:** ~260 KB gzipped (parser + geometry + renderer).
- **Schema coverage:** 100% of IFC4 (776 entities) and IFC4X3 (876 entities).
- **Parse throughput:** ~1,259 MB/s tokenization on a typical M1 / M2 laptop.

See [benchmarks](https://ltplus-ag.github.io/ifc-lite/guide/performance/) for full numbers across model sizes and hardware.

## Examples

Ready-to-run projects in [`examples/`](examples/):

- [**Three.js Viewer**](examples/threejs-viewer/) — IFC viewer using Three.js (WebGL)
- [**Babylon.js Viewer**](examples/babylonjs-viewer/) — IFC viewer using Babylon.js (WebGL)

## Documentation

| | |
|---|---|
| **Start here** | [Quick Start](https://ltplus-ag.github.io/ifc-lite/guide/quickstart/) · [Installation](https://ltplus-ag.github.io/ifc-lite/guide/installation/) · [Browser Requirements](https://ltplus-ag.github.io/ifc-lite/guide/browser-requirements/) |
| **Guides** | [Parsing](https://ltplus-ag.github.io/ifc-lite/guide/parsing/) · [Geometry](https://ltplus-ag.github.io/ifc-lite/guide/geometry/) · [Rendering](https://ltplus-ag.github.io/ifc-lite/guide/rendering/) · [Querying](https://ltplus-ag.github.io/ifc-lite/guide/querying/) · [Exporting](https://ltplus-ag.github.io/ifc-lite/guide/exporting/) |
| **BIM features** | [Federation](https://ltplus-ag.github.io/ifc-lite/guide/federation/) · [BCF](https://ltplus-ag.github.io/ifc-lite/guide/bcf/) · [IDS Validation](https://ltplus-ag.github.io/ifc-lite/guide/ids/) · [2D Drawings](https://ltplus-ag.github.io/ifc-lite/guide/drawing-2d/) · [Property Editing](https://ltplus-ag.github.io/ifc-lite/guide/mutations/) |
| **Tutorials** | [Build a Viewer](https://ltplus-ag.github.io/ifc-lite/tutorials/building-viewer/) · [Three.js](https://ltplus-ag.github.io/ifc-lite/tutorials/threejs-integration/) · [Babylon.js](https://ltplus-ag.github.io/ifc-lite/tutorials/babylonjs-integration/) · [Custom Queries](https://ltplus-ag.github.io/ifc-lite/tutorials/custom-queries/) |
| **Deep dives** | [Architecture](https://ltplus-ag.github.io/ifc-lite/architecture/overview/) · [Data Flow](https://ltplus-ag.github.io/ifc-lite/architecture/data-flow/) · [Performance](https://ltplus-ag.github.io/ifc-lite/guide/performance/) |
| **API** | [TypeScript](https://ltplus-ag.github.io/ifc-lite/api/typescript/) · [Rust](https://ltplus-ag.github.io/ifc-lite/api/rust/) · [WASM](https://ltplus-ag.github.io/ifc-lite/api/wasm/) |

## Contributing

The WASM bundle is built from `rust/` on every fresh build, so a Rust
toolchain is required. `rust-toolchain.toml` pins the nightly channel
and the `wasm32-unknown-unknown` target — `rustup show` (or the
contributing setup guide) installs everything needed.

```bash
# 1. Rust toolchain (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack   # or: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# 2. Clone and build
git clone https://github.com/LTplus-AG/ifc-lite.git
cd ifc-lite
pnpm install && pnpm build && pnpm dev   # opens viewer at localhost:5173
```

If you need IFC fixtures for tests, benchmarks, or stress tests, fetch them with:

```bash
pnpm fixtures           # download every fixture (idempotent, hash-verified)
pnpm fixtures:check     # CI-friendly: exit 1 if anything is missing or stale
```

The fixtures are stored on a GitHub Release and catalogued in
[`tests/models/manifest.json`](tests/models/manifest.json) — see
[`tests/models/README.md`](tests/models/README.md) for the full design and
maintainer workflow.

See the [Contributing Guide](https://ltplus-ag.github.io/ifc-lite/contributing/setup/) and [Release Process](RELEASE.md).

## Community

- [GitHub Discussions](https://github.com/LTplus-AG/ifc-lite/discussions) — questions, ideas, show-and-tell
- [Issues](https://github.com/LTplus-AG/ifc-lite/issues) — bug reports and feature requests
- [Releases](https://github.com/LTplus-AG/ifc-lite/releases) — changelog and version notes

## License

[MPL-2.0](LICENSE) — use, modify, redistribute. Source files modified under MPL must remain MPL.
