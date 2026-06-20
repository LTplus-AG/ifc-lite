---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

Move the KMZ (Google Earth) exporter to Rust. The `ifc-lite-export` crate now
assembles the KMZ archive (`doc.kml` + `model.glb`) and computes the IFC
grid-north → KML heading, exposed via the wasm `exportKmz` binding and
`GeometryProcessor.exportKmz`. The viewer's `buildKmz` is now a thin async caller
(matching the OBJ/glTF/CSV pattern); the GLB it packages is already produced by the
Rust GLB exporter. The archive uses a hand-rolled stored-ZIP writer so the wasm
bundle pulls in no zip/deflate dependency.
