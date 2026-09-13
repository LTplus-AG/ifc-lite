---
"@ifc-lite/geometry": major
"@ifc-lite/server-bin": patch
---

Keep the public geometry bridge and downloadable server binary aligned with the implementations they expose.

- `@ifc-lite/geometry`: `GeometryProcessor.getApi()` and `IfcLiteBridge.getApi()` expose the concrete `@ifc-lite/wasm` `IfcAPI`, so the breaking PDF-fidelity and scan-transfer JSON migrations in WASM 8 are also breaking for callers that obtain the API through Geometry. Geometry therefore advances to 6.0.0 instead of accepting only a dependency patch.
- `@ifc-lite/server-bin`: publish fresh binaries containing the server-release unwinding profile, the bounded stalled-stream permit timeout, and bounded cache-invalidation walks. The previous 1.17.0 package resolves the older September 4 binary release and cannot contain those fixes.
