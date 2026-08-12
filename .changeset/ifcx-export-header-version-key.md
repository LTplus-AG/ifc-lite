---
"@ifc-lite/wasm": patch
---

Write the IFCX header version under `ifcxVersion`, so exported files can be read back. The Rust IFC5 exporter emitted `header.version`, but readers look for `header.ifcxVersion` — the key buildingSMART's own reference files use and the one `@ifc-lite/ifcx` requires. Every file `ifc-lite export --format ifcx` produced was therefore rejected by our own parser with "Invalid IFCX file: missing or invalid header.ifcxVersion", which also meant an exported file could not be opened in the viewer. Every other IFCX writer in the repo (the TS `ifc5-exporter`, `packages/ifcx`'s writer, the layer-stack publish path) already used `ifcxVersion`; the Rust exporter was the only outlier. Verified by renaming just that key on an exported file: the same bytes go from rejected to parsed.
