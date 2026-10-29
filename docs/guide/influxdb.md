# Experimental InfluxDB 2 viewer panel

Open **InfluxDB 2** from the viewer's panel browser (Site group). Load an IFC
model, enter the InfluxDB URL, organization, bucket, measurement, numeric field,
GUID tag key (default `ifc_guid`) and display unit. Enter a bucket-read token in
the password field, then click **Load**. Connection settings are saved in browser
localStorage. The token stays in the mounted panel's memory and is discarded
when the panel unmounts or the page closes; enter it again when reopening.

Select an `IfcSpace` or `IfcSensor` in the loaded model. A unique exact IFC
`GlobalId` match shows its latest numeric value, timestamp and history line.
Series absent from the model appear under Unmatched. Competing series and
GlobalIds shared by multiple entities or loaded models appear under Ambiguous;
none is chosen automatically. Removing a model recomputes that classification.

Each load requests the last hour and at most 10,000 samples. A 10,001st sample,
malformed CSV, nonnumeric value, conflicting reading or InfluxDB error table
fails the entire load. Responses are limited to 2 MiB and 15 seconds. Units are
display labels; no conversion is performed. Readings are refreshed only by
clicking Load. A timestamp is displayed but there is no automatic freshness
assessment. The configuration is experimental, not a saved model mapping.

The browser contacts `/api/v2/query` directly with `Authorization: Token …`.
There is no ifc-lite proxy. Use HTTPS, or `http://localhost` for development;
URLs with embedded credentials, query strings or fragments are refused.
InfluxDB must allow the viewer origin through CORS. A gateway, if needed, must
have a fixed upstream and allow the viewer origin; do not deploy an unrestricted
URL proxy. HTTP failures omit the upstream body; network failures explain the
CORS requirement. Tokens do not enter viewer exports, URLs or persisted state.

This MVP supports InfluxDB 2 / generated Flux and IFC GlobalId tags only. It
adds no scene coloring, manual mappings or property/BMS-ID matching. Follow-ups
include connection testing, polling, stale-data indication, configurable
lookback and mobile witness coverage. The screenshot witness uses explicitly
synthetic data seeded to GlobalIds from the committed SketchUp IFC sample.
