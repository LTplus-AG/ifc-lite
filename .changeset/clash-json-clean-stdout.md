---
"@ifc-lite/cli": patch
---

`ifc-lite clash --json` now emits exactly one JSON document on stdout. Geometry and opening-pipeline diagnostics ("[IFC-LITE] ..." lines from the wasm print bindings and geometry processing) are routed to stderr for the whole clash run, in both JSON and human output modes, so consumers can `JSON.parse` stdout directly instead of scraping the trailing JSON. The JSON payload schema is unchanged.
