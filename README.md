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

Parse, view, query, edit, validate, and export IFC files, entirely client-side. A Rust core compiled to WASM does the parsing and geometry, a WebGPU renderer puts it on screen, and 36 npm packages let you pick exactly the pieces you need. Geometry runs on an exact-arithmetic CSG kernel, verified element-by-element against IfcOpenShell across the public benchmark corpus.

Works with **IFC2X3**, **IFC4 / IFC4X3** and **IFC5 (IFCX)**. Live demo at [ifclite.com](https://www.ifclite.com/) and more info at [ifclite.dev](https://www.ifclite.dev/).

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

Prefer the terminal? The whole toolkit is also a CLI:

```bash
npm install -g @ifc-lite/cli
ifc-lite info model.ifc
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

For Three.js or Babylon.js, parse and extract geometry the same way and feed `meshes` to your engine. See [Three.js integration](https://ifclite.dev/docs/tutorials/threejs-integration/) and [Babylon.js integration](https://ifclite.dev/docs/tutorials/babylonjs-integration/).

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
import { createDataAccessor } from '@ifc-lite/ids/bridge';

const idsSpec = parseIDS(idsXmlContent);
const accessor = createDataAccessor(store);
const modelInfo = {
  modelId: 'my-model',
  schemaVersion: store.schemaVersion,
  entityCount: store.entityCount,
};
const translator = createTranslationService('en');
const report = await validateIDS(idsSpec, accessor, modelInfo, { translator });

for (const spec of report.specificationResults) {
  console.log(`${spec.specification.name}: ${spec.passRate}% passed`);
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
import { exportToStep, ParquetExporter, Ifc5Exporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';

// Assumes the earlier parse/geometry steps: `store` (parsed IfcDataStore),
// `bytes` (raw IFC Uint8Array), `meshes` + `geometryResult` (from geometry).

// IFC STEP, applies any pending mutations
const stepText = exportToStep(store, { schema: 'IFC4', applyMutations: true });

// glTF / GLB, CSV and JSON-LD are assembled in Rust (ifc-lite-export)
// via the GeometryProcessor
const gp = new GeometryProcessor();
await gp.init();
const glb = gp.exportGlbFromMeshes(meshes);  // Uint8Array (no re-mesh)
const csv = gp.exportCsv(bytes, 'entities', ',', /* includeProperties */ true);
const jsonld = gp.exportJsonld(bytes);

// Parquet: columnar, queryable from DuckDB / Polars
const parquet = await new ParquetExporter(store).exportTable('entities');

// IFC5 / IFCX: JSON + USD geometry
const ifcx = new Ifc5Exporter(store, geometryResult).export({ includeGeometry: true });
```

## Work from the terminal

The [`ifc-lite` CLI](https://ifclite.dev/docs/guide/cli/) covers the full toolkit: inspect, query, validate, export, create, diff, clash-check, merge, convert, and script IFC models without writing a line of app code.

```bash
ifc-lite info model.ifc                                  # schema, entities, storeys
ifc-lite query model.ifc --type IfcWall --json           # entities with properties
ifc-lite ids model.ifc requirements.ids                  # IDS validation
ifc-lite clash model.ifc --matrix --bcf clashes.bcfzip   # clash detection to BCF
ifc-lite diff model-v1.ifc model-v2.ifc                  # model comparison
ifc-lite merge arch.ifc struct.ifc mep.ifc --out fed.ifc # federation
ifc-lite convert model.ifc --schema IFC4 --out out.ifc   # schema conversion
ifc-lite view model.ifc                                  # 3D viewer + REST API
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
```

Building AI tooling? `ifc-lite mcp model.ifc` starts a [Model Context Protocol](https://ifclite.dev/docs/guide/cli/) server (stdio or HTTP) so agents can query and edit BIM data directly, and `ifc-lite ask model.ifc "how many walls?"` answers natural-language questions.

## Choose your setup

| Setup | Best for | You get |
|-------|----------|---------|
| [**Browser (WebGPU)**](https://ifclite.dev/docs/guide/quickstart/) | Viewing and inspecting models | Full-featured 3D viewer, runs entirely client-side |
| [**Three.js / Babylon.js**](https://ifclite.dev/docs/tutorials/threejs-integration/) | Adding IFC support to an existing 3D app | IFC parsing + geometry, rendered by your engine |
| [**CLI**](https://ifclite.dev/docs/guide/cli/) | Scripting, CI pipelines, AI agents | The whole toolkit from the terminal, JSON output everywhere |
| [**Server**](https://ifclite.dev/docs/guide/server/) | Teams, large files, repeat access | Rust backend with caching, parallel processing, streaming |
| [**Build for Desktop**](https://ifclite.dev/docs/guide/desktop/) | Your own offline native app, very large files (500 MB+) | Extension points to wrap the packages in Tauri, with an optional native-Rust geometry fast path |
| [**Python (native wheel)**](https://ifclite.dev/docs/api/python/) | Analysis, scripting, scientific Python | `pip install ifclite-geom` runs the geometry kernel in-process, meshes straight to numpy |

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
| Detect clashes | + `@ifc-lite/clash` |
| Diff two model versions | + `@ifc-lite/diff` |
| BCF issue tracking | + `@ifc-lite/bcf` |
| Filter and colorize in 3D by rules | + `@ifc-lite/lens` |
| Build schedules and property tables | + `@ifc-lite/lists` |
| Script models with the `bim.*` API | + `@ifc-lite/sdk` |
| Real-time collaboration (CRDT on IFCX) | + `@ifc-lite/collab` + `@ifc-lite/collab-server` |
| Embed the viewer in any page (iframe) | + `@ifc-lite/embed-sdk` |
| Connect to a server backend | + `@ifc-lite/server-client` |
| Give AI agents BIM access (MCP) | + `@ifc-lite/mcp` |

Full list: [API Reference](https://ifclite.dev/docs/api/typescript/) (36 npm packages, 6 Rust crates on crates.io, and the `ifclite-geom` Python wheel on PyPI).

## Performance

- **Streaming first render:** geometry is processed in batches, so the first triangles are on screen while the rest of the file is still parsing.
- **Geometry correctness:** exact-arithmetic boolean kernel — every opening is cut exactly, and the output is verified element-by-element against IfcOpenShell (99.9%+ agreement on the public benchmark corpus). Engines with approximate booleans are faster on boolean-heavy models; that trade is deliberate.
- **Geometry speed:** native (server/CLI, multi-threaded) beats `web-ifc` on most of the benchmark corpus; in the browser the viewer streams geometry across workers so the first triangles render long before the file finishes processing.
- **Parse speed:** STEP tokenization runs at roughly 1.2 GB/s; a full parse lands around 50 MB/s.
- **Schema coverage:** 100% of IFC4 (776 entities) and IFC4X3 (876 entities).
- **Footprint:** one lazily fetched WASM module (~1.2 MB gzipped) plus small per-package JS wrappers.

See [benchmarks](https://ifclite.dev/docs/guide/performance/) for full numbers across model sizes and hardware.

## Examples

Ready-to-run projects in [`examples/`](examples/):

- [**Three.js Viewer**](examples/threejs-viewer/) - IFC viewer using Three.js (WebGL)
- [**Babylon.js Viewer**](examples/babylonjs-viewer/) - IFC viewer using Babylon.js (WebGL)
- [**Collab Demo**](examples/collab-demo/) - real-time collaborative editing over websockets
- [**Three.js Collab**](examples/threejs-collab/) - collaborative 3D viewing in Three.js

## Documentation

| | |
|---|---|
| **Start here** | [Quick Start](https://ifclite.dev/docs/guide/quickstart/) · [Installation](https://ifclite.dev/docs/guide/installation/) · [CLI Toolkit](https://ifclite.dev/docs/guide/cli/) · [Browser Requirements](https://ifclite.dev/docs/guide/browser-requirements/) |
| **Guides** | [Parsing](https://ifclite.dev/docs/guide/parsing/) · [Geometry](https://ifclite.dev/docs/guide/geometry/) · [Rendering](https://ifclite.dev/docs/guide/rendering/) · [Querying](https://ifclite.dev/docs/guide/querying/) · [Exporting](https://ifclite.dev/docs/guide/exporting/) |
| **BIM features** | [Federation](https://ifclite.dev/docs/guide/federation/) · [BCF](https://ifclite.dev/docs/guide/bcf/) · [IDS Validation](https://ifclite.dev/docs/guide/ids/) · [2D Drawings](https://ifclite.dev/docs/guide/drawing-2d/) · [Property Editing](https://ifclite.dev/docs/guide/mutations/) |
| **Customization** | [Extensions](https://ifclite.dev/docs/guide/extensions/) · [Authoring Extensions](https://ifclite.dev/docs/guide/extension-authoring/) · [Flavors](https://ifclite.dev/docs/guide/flavors/) |
| **Tutorials** | [Build a Viewer](https://ifclite.dev/docs/tutorials/building-viewer/) · [Three.js](https://ifclite.dev/docs/tutorials/threejs-integration/) · [Babylon.js](https://ifclite.dev/docs/tutorials/babylonjs-integration/) · [Custom Queries](https://ifclite.dev/docs/tutorials/custom-queries/) |
| **Deep dives** | [Architecture](https://ifclite.dev/docs/architecture/overview/) · [Data Flow](https://ifclite.dev/docs/architecture/data-flow/) · [Performance](https://ifclite.dev/docs/guide/performance/) |
| **API** | [TypeScript](https://ifclite.dev/docs/api/typescript/) · [Rust](https://ifclite.dev/docs/api/rust/) · [WASM](https://ifclite.dev/docs/api/wasm/) · [Python](https://ifclite.dev/docs/api/python/) |

## Contributing

The WASM bundle is built from `rust/` on every fresh build, so a Rust
toolchain is required. `rust-toolchain.toml` pins the nightly channel
and the `wasm32-unknown-unknown` target. `rustup show` (or the
contributing setup guide) installs everything needed.

```bash
# 1. Rust toolchain (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack   # or: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# 2. Clone and build
git clone https://github.com/LTplus-AG/ifc-lite.git
cd ifc-lite
pnpm install && pnpm build && pnpm dev   # opens viewer at localhost:3000
```

If you need IFC fixtures for tests, benchmarks, or stress tests, fetch them with:

```bash
pnpm fixtures           # download every fixture (idempotent, hash-verified)
pnpm fixtures:check     # CI-friendly: exit 1 if anything is missing or stale
```

The fixtures are stored on a GitHub Release and catalogued in
[`tests/models/manifest.json`](tests/models/manifest.json). See
[`tests/models/README.md`](tests/models/README.md) for the full design and
maintainer workflow.

See the [Contributing Guide](https://ifclite.dev/docs/contributing/setup/) and [Release Process](RELEASE.md).

## Community

- [GitHub Discussions](https://github.com/LTplus-AG/ifc-lite/discussions) - questions, ideas, show-and-tell
- [Issues](https://github.com/LTplus-AG/ifc-lite/issues) - bug reports and feature requests
- [Releases](https://github.com/LTplus-AG/ifc-lite/releases) - changelog and version notes

## License

[MPL-2.0](LICENSE) - use, modify, redistribute. Source files modified under MPL must remain MPL.
