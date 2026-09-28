---
"@ifc-lite/server-client": minor
---

Carry the IFC-authored specular finish (#5582) over the server transports (#5984). `MeshData` gains optional `metallic` / `roughness`, sent by `POST /api/v1/parse`, the SSE stream, and both Parquet transports (new non-nullable `metallic` / `roughness` columns, NaN where unauthored, decoded by both Parquet decoders). The server joins each mesh's finish from the style its colour came from, which now also reaches type geometry and finishes styled on an `IfcMappedItem`. The viewer maps them into `MeshData.material`, so an authored roughness of 0 survives.
