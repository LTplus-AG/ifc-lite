---
"@ifc-lite/cli": patch
---

`simplify --json`, `lod --json`, `extract-entities --json` and the `gym` NDJSON protocol now put only their payload on stdout. All four drove the geometry pipeline without first calling `routeConsoleDiagnosticsToStderr()`, so roughly 25 lines of `[IFC-LITE] Opening classifier: …` arrived ahead of the document and `JSON.parse` failed on character 1 — while the exit code stayed 0. `gym`'s consumer got non-JSON on the very first line it read, before it could send a message.
