# Developer workflows

Start with the result you need. The TypeScript SDK and CLI support headless work; geometry and rendering are separate choices.

| Task | Entry point | Runtime |
|------|-------------|---------|
| Query and edit a loaded IFC model | `@ifc-lite/sdk/headless` → `openModel` | Node or browser |
| Parse into a source data store | `@ifc-lite/parser` → `parseModel` | Node or browser |
| Inspect files and automate checks | `@ifc-lite/cli` → `ifc-lite` | Node |
| Extract meshes for your engine | `@ifc-lite/geometry` → `GeometryProcessor` | WASM-capable Node or browser |
| Process through a native service | `@ifc-lite/server-client` + Rust server | HTTP client + server |
| Integrate from Rust | `ifc-lite-core`, `ifc-lite-processing` | Native Rust |
| Extract geometry in Python | `ifclite-geom` | Python; see the wheel's supported platforms |

The [TypeScript reference](../api/typescript.md) lists the modular packages. [Rust](../api/rust.md) and [Python](../api/python.md) have their own contracts; they do not imply every scripting namespace is available in every runtime.

## First useful result

Install the SDK and a TypeScript script runner:

```bash
npm install @ifc-lite/sdk
npm install --save-dev tsx
```

Save this as `inspect.mts` and run `npx tsx inspect.mts model.ifc`:

```typescript
import { readFile } from 'node:fs/promises';
import { openModel } from '@ifc-lite/sdk/headless';

const model = await openModel(await readFile(process.argv[2] ?? 'model.ifc'));
try {
  if (model.report.completeness !== 'complete') throw new Error('Record coverage is incomplete or unknown');
  const doors = model.bim.query().byType('IfcDoor').toArray();
  console.log(JSON.stringify(doors.map(door => ({
    GlobalId: door.globalId,
    Name: door.name,
    FireRating: model.bim.property(door.ref, 'Pset_DoorCommon', 'FireRating'),
  })), null, 2));
} finally {
  model.close();
}
```

For a terminal workflow:

```bash
npx @ifc-lite/cli info model.ifc --json
npx @ifc-lite/cli query model.ifc --type IfcDoor --props --json
```

## Reference model and runnable recipes

The independently authored ArchiCAD FZK reference model has five doors. From a source checkout, fetch it through the manifest-backed, hash-verified fixture command and build the examples:

```bash
pnpm install
node scripts/fixtures/fetch-fixtures.mjs ara3d/AC20-FZK-Haus.ifc
pnpm exec turbo build --filter=ifc-lite-headless-workflows --concurrency=2
```

The [complete recipe files](https://github.com/LTplus-AG/ifc-lite/tree/main/examples/headless-workflows) share one helper that opens the model, requires known complete record coverage, and closes it on success or error.

| Recipe | Run from the repository root | Result |
|--------|------------------------------|--------|
| Extract data | `node examples/headless-workflows/dist/extract.mjs tests/models/ara3d/AC20-FZK-Haus.ifc` | JSON containing five doors with exact IFC attribute names |
| Validate IDS | `node examples/headless-workflows/dist/validate.mjs tests/models/ara3d/AC20-FZK-Haus.ifc examples/headless-workflows/doors-have-names.ids` | Native report evaluating five door names |
| Edit/export/reopen | `node examples/headless-workflows/dist/edit.mjs tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/edited.ifc` | A checked property is verified after reopening the exported file |
| Extract geometry | `node examples/headless-workflows/dist/geometry.mjs tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/model.glb` | A GLB assembled from the processor's meshes |
| Run a service | `node examples/headless-workflows/dist/server.mjs` | `POST /doors`, bounded workers and request cancellation |

The IDS recipe exits 1 for a failed specification and 2 when no entities were evaluated. It retains the native report rather than turning an empty evaluation into a success summary. Use your own IDS document to test different requirements.

Geometry needs the runtime artifact. In a source checkout without Rust, run `pnpm build:wasm:fetch`; a published consumer gets the WASM package through npm. The processor recipe uses the canonical export path and always disposes the processor. To feed meshes directly into another engine, preserve per-mesh origins and the returned coordinate frame; follow the [geometry guide](geometry.md) and the [Three.js integration](../tutorials/threejs-integration.md).

## A cancellable local service

The service recipe accepts IFC bytes at `POST /doors` and runs each query in an owned Node worker. Disconnect and timeout terminate that worker, including synchronous parsing work. It limits uploads to 16 MiB, concurrent requests to two, and each operation to 30 seconds. These are explicit example budgets; the [Rust server](server.md) provides the native processing deployment path.

```bash
node examples/headless-workflows/dist/server.mjs
curl -f -H 'Content-Type: application/octet-stream' --data-binary @tests/models/ara3d/AC20-FZK-Haus.ifc http://127.0.0.1:3001/doors
curl -f http://127.0.0.1:3001/health
```

`/health` exposes active request/worker counts. The worker input is an exact transferred allocation, so a pooled Node Buffer cannot expose unrelated bytes. Results and parse refusals are JSON; interrupted requests release their worker before the concurrency slot is reused.

## Integration contracts to keep explicit

A scan report describes record coverage, independently of IDS/schema conformance and geometry coverage. Treat `unknown` as unknown. The validated loader refuses invalid envelopes; the tolerant `IfcParser.parseColumnar` remains available for recovery tooling. See [parsing](parsing.md#load-step-data-without-a-viewer).

Use `bim` for queries that include pending edits; `model.store` is the original source snapshot. A reference pairs a session `modelId` with its local `expressId`. IFC `GlobalId` is a different identifier, and the same EXPRESS number in two loaded files identifies different records. Use an explicitly verified source identity when persisting results across sessions. See [stable identity](stable-identity.md).

`model.capability(operation)` tells you whether a backend method is implemented/configured. It does not guarantee a native runtime or valid input. The session throws structured errors for unsupported operations and backend calls after close. Closing releases preparation caches; source arrays remain alive while your application retains them. See [the SDK lifecycle](scripting-sdk.md#open-a-headless-model).

File length units, normalized mesh metres, Y-up mesh coordinates and IFC Z-up coordinates are separate contracts. Preserve `coordinateInfo` and mesh origins when handing geometry to another system. See [coordinate handling](../architecture/coordinate-handling.md).

For a failure report, include package/runtime versions, the operation, structured error/scan codes, and a shareable reproducing fixture or its hash. Keep credentials and private model bytes out of reports. See [error handling](error-handling.md).
