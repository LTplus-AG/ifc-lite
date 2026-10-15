# Headless developer workflows

Complete Node entry points for extracting IFC data, validating IDS, editing and reopening IFC, exporting geometry, and running a bounded service. They consume the public packages and share the model-loading/lifetime helper in `src/common.mts`.

From the repository root:

```bash
pnpm install
node scripts/fixtures/fetch-fixtures.mjs ara3d/AC20-FZK-Haus.ifc
pnpm exec turbo build --filter=ifc-lite-headless-workflows --concurrency=2
```

The fixture fetch verifies the manifest SHA-256. For geometry on a host without Rust, fetch the published WASM runtime with `pnpm build:wasm:fetch` before building. Data-only scripts do not initialize geometry.

```bash
node examples/headless-workflows/dist/extract.mjs tests/models/ara3d/AC20-FZK-Haus.ifc
node examples/headless-workflows/dist/validate.mjs tests/models/ara3d/AC20-FZK-Haus.ifc examples/headless-workflows/doors-have-names.ids
node examples/headless-workflows/dist/edit.mjs tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/edited.ifc
node examples/headless-workflows/dist/geometry.mjs tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/model.glb
```

Extraction returns five doors. The example IDS checks their `Name` attributes; its native report checks five entities. The edit script adds `DX_Example.Checked` to one door, writes IFC, reopens it, finds the same `GlobalId`, and verifies the value. The geometry script reserves stdout for its JSON result, sends runtime diagnostics to stderr, and disposes its processor even if initialization or export fails.

The validation script exits 0 when evaluated specifications pass, 1 when a specification fails, and 2 when no entities were evaluated. The full native report remains on stdout. Incomplete or unknown record coverage is refused before the model-wide recipes run.

Start the local service:

```bash
node examples/headless-workflows/dist/server.mjs
curl -f -H 'Content-Type: application/octet-stream' --data-binary @tests/models/ara3d/AC20-FZK-Haus.ifc http://127.0.0.1:3001/doors
curl -f http://127.0.0.1:3001/health
```

`POST /doors` accepts IFC bytes and returns the door rows. Requests are bounded to 16 MiB, two active requests, and 30 seconds; excess capacity returns 503 and oversized inputs return 413. A disconnected or timed-out request terminates its owned Node worker, so parsing can be stopped even during synchronous work. `/health` reports active requests and workers. `PORT=0` selects an available port and the process prints its actual loopback URL.

Compile before running: the service starts the compiled `worker.mjs` beside it. For server-side native geometry and shared processing caches, use the [Rust server](../../docs/guide/server.md). The [developer guide](../../docs/guide/developer-workflows.md) explains package choices, identity, units, completeness, and lifecycle.
