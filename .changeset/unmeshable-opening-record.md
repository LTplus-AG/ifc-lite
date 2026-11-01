---
'@ifc-lite/wasm': patch
'@ifc-lite/geometry': patch
'@ifc-lite/server-client': patch
---

An opening that could not be used to cut its host left no trace in the geometry diagnostics: when its id did not decode, or its own body failed to mesh or meshed empty, the host was kept whole and nothing said why. Such an opening is now counted as one dropped item in `unsupportedItemsByType`, under the opening's type (for example `IfcOpeningElement`), or under `IfcFeatureElementSubtraction` when the id itself could not be read. It is counted once per opening per geometry router, so the CLI `diagnose-geometry` report and the viewer's load report now answer "why didn't this window get cut".

Because `totalUnsupportedItems` / `unsupportedItemsByType` now count more than they did, `GeometryDiagnostics.schemaVersion` moves from 3 to 4 (count-semantics change). No field is added or renamed, and mesh output is unchanged.
