# Headless developer workflows

Complete Node entry points for extracting IFC data, validating IDS, editing and reopening IFC, exporting geometry, and running a bounded service. They consume the public packages and share the model-loading/lifetime helper in `src/common.mts`.

From the repository root:

```bash
pnpm install
node scripts/fixtures/fetch-fixtures.mjs ara3d/AC20-FZK-Haus.ifc
pnpm exec turbo build --filter=ifc-lite-headless-workflows --concurrency=2
```

While editing the extraction recipe, run `pnpm --filter ifc-lite-headless-workflows extract:dev ../../tests/models/ara3d/AC20-FZK-Haus.ifc` from the repository root. This runs source directly through tsx.

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

## InfluxDB 2 / IFC mapping spike (#8090)

This experimental recipe tests the existing Flow HTTP, CSV and entity-join nodes.
It produces an offline HTML inspector with latest readings, selectable entity
history, unmatched series and ambiguous assignments. It does not add a viewer
panel or change the IFC model.

After building, try it without a database:

```bash
node examples/headless-workflows/dist/influx.mjs apps/viewer/public/samples/building-architecture.ifc --demo /tmp/ifc-monitoring.html
```

Open the generated HTML in a browser. The demo is explicitly **synthetic
telemetry**, linked to the parsed sample's real IFC entities. Three readings
belong to the living room; two devices competing for the entry hall remain
ambiguous, and an unknown GUID stays unmatched. No database request occurs in
demo mode. The report refuses to overwrite an existing file.

For a real InfluxDB 2 / Flux service, copy `influx-selection.example.json` and
configure its HTTPS URL, organization, bucket, measurement, numeric field,
GUID tag, optional exact tag predicates, lookback, sample cap and display unit.
Supply a bucket-scoped read token as `INFLUX_TOKEN` in the process environment,
then run:

```bash
node examples/headless-workflows/dist/influx.mjs model.ifc /path/to/selection.json /tmp/live-monitoring.html
```

The configuration contains no token; the generated graph uses a secret
reference. The runner uses existing Flow interpolation and redaction; credentials
are not persisted. This is a headless recipe: the browser Flow runner continues
to refuse graphs requiring secrets. The exported report does contain building
identities and telemetry, so share it deliberately.

The generated Flux groups to one table and requests CSV **without annotations**.
Both the headless recipe and viewer use `parseInfluxCsv` for strict quoting
and response-envelope validation, rejecting annotated/multi-table Flux output. A sentinel sample detects overflow; oversized,
malformed, nonnumeric, HTTP-error and error-table responses fail explicitly.
Latest values are computed per complete tag set, preserving nanosecond ordering.
Only that latest table goes into `table.joinByKey`; raw history would falsely
make every entity with several samples ambiguous. The plot uses millisecond
display coordinates, with original timestamps retained.

Limits: one loaded model, GUID matching to `IfcSpace`/`IfcSensor`, one numeric
field, at most 24 hours and 10,000 samples, explicit display units, no polling,
downsampling, property-tag matching, raw Flux, 3D selection or scene coloring.
The lookback bounds what “latest” means; this spike does not certify freshness.
InfluxDB 3 is unsupported. Plain HTTP LAN endpoints require a separately
configured HTTPS gateway; this recipe does not introduce an open proxy.

The disposable live witness is `node scripts/spikes/influxdb-live.mjs /tmp/live.html`
(run through the registered fleet launcher). It starts a CPU/memory-bounded
InfluxDB 2.7.12 container, seeds synthetic measurements, creates a bucket-read
token, verifies that token cannot write, and runs the recipe through a loopback
HTTPS test gateway with a temporary trusted certificate. It removes its own
container and certificate directory in `finally`. Docker and OpenSSL are required.
This proves the real Flux query and response path; it does not validate a
production gateway, browser CORS or a customer's monitoring schema.

Spike verdict (2026-10-24): the live InfluxDB 2.7.12 query mapped the SketchUp
sample's living room at 22.5 °C, retained its three historical samples, and
reported one unknown series and two competing entry-hall devices separately.
The read token's write attempt returned HTTP 403, and the exported HTML
contained neither provisioning nor query credentials. Existing Flow machinery
is sufficient for a headless proof; only response-envelope validation and
latest-per-series reduction are specific adapters here. A viewer integration
still needs session-only credential input, selection/lifecycle wiring and
deployment-specific CORS or gateway handling.

The query generator and CSV/latest-per-series adapters now live in the pure
`@ifc-lite/flow-nodes/influx` entry point, shared with the Experimental viewer
panel. The recorded spike evidence retains its original source hashes.
