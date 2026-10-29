# Experimental InfluxDB 2 viewer panel

Open **InfluxDB 2** from the viewer's panel browser (Site group). Load an IFC
model, enter the InfluxDB URL, organization, bucket, measurement, numeric field,
GUID tag key (default `ifc_guid`) and an optional display unit. Enter a bucket-read token in
the password field, then click **Load**. Connection settings are saved in browser
localStorage only when no field contains the raw or URI-encoded token. The token stays in the mounted panel's memory and is discarded
when the panel unmounts or the page closes; enter it again when reopening.

Select an `IfcSpace` or `IfcSensor` in the loaded model. A unique exact IFC
`GlobalId` match shows its latest numeric value, timestamp and history line.
Series absent from the model appear under Unmatched. Competing series and
GlobalIds shared by multiple entities or loaded models appear under Ambiguous;
none is chosen automatically. Removing a model recomputes that classification.

Each load requests the last hour and at most 10,000 samples. A 10,001st sample,
malformed CSV, nonnumeric value, conflicting reading or InfluxDB error table
fails the entire load. Decoded CSV headers or cells containing the token (raw
or URI-encoded) also reject the whole response; series tags are never rewritten. Responses are limited to 2 MiB and 15 seconds. Units are
display labels; no conversion is performed. Readings are refreshed only by
clicking Load. A timestamp is displayed but there is no automatic freshness
assessment. The configuration is experimental, not a saved model mapping.

The browser contacts `/api/v2/query` directly with `Authorization: Token …`.
There is no ifc-lite proxy. Use HTTPS, or `http://localhost` for development;
URLs with embedded credentials, query strings or fragments are refused.
For cross-origin InfluxDB OSS 2 queries, use a gateway that allows the viewer
origin; OSS has no CORS configuration. The gateway must have a fixed upstream;
do not deploy an unrestricted URL proxy. HTTP failures omit the upstream body; network failures explain the
CORS requirement. Tokens do not enter viewer exports, URLs or persisted state.

This MVP supports InfluxDB 2 / generated Flux and IFC GlobalId tags only. It
adds no scene coloring, manual mappings or property/BMS-ID matching. Follow-ups
include connection testing, polling, stale-data indication, configurable
lookback and mobile witness coverage. The screenshot witness uses explicitly
synthetic data seeded to GlobalIds from the committed SketchUp IFC sample.

To reproduce the desktop witness on an admitted development worker with
Chromium and either Docker or a verified InfluxDB OSS 2 binary, first build the viewer's dependencies and WASM through the root
build graph, then run `node scripts/spikes/influx-viewer-live.mjs NEW_OUTPUT_DIR`.
The script uses the repository's Playwright workflow so the browser and the
loopback database gateway run on the same host. It records the database image
digest (Docker mode), or binary version and SHA256 (`INFLUXD_BIN` mode), plus
the source commit, model hash and data checks alongside `desktop.png`.
No token or browser trace is retained. `CHROME_EXECUTABLE` can name an installed
Chromium; otherwise Playwright's installed browser is used.

Set `INFLUXD_BIN=/absolute/path/to/influxd` to use the native binary instead of
Docker. Verify the official archive against the SHA256 published in the
[InfluxDB release](https://github.com/influxdata/influxdb/releases/tag/v2.7.12)
before running it. This mode binds to a free loopback port and uses temporary
Bolt, engine and SQLite paths. Both modes use the same fixed-upstream loopback
gateway, stop their owned services, and remove database storage after the run.
The viewer witness and binary provenance are recorded in
[the validation manifest](../architecture/evidence/influxdb-8090/viewer/validation.json).
