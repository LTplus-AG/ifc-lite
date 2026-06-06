---
"@ifc-lite/wasm": patch
---

Render type-only tessellated geometry that has no occurrence (#957).

buildingSMART annex-E "tessellated shape with style" files (and similar IFC
type libraries) attach their geometry to an `IfcXxxType` via `RepresentationMaps`
with no product instance, so the model displayed empty. The geometry now renders
for any `RepresentationMap` that no `IfcMappedItem` instantiates — both in the
native `process_geometry` path and the browser's `processGeometryBatch` viewer
path — without double-rendering normally-instanced typed products. (The reported
"unsupported `IfcBlobTexture`" was a red herring: the blob parses fine and the
surface style falls back to its base colour; the geometry now renders flat white.
Full texture rendering is tracked separately.)
