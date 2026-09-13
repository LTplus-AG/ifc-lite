---
'@ifc-lite/geometry': major
'@ifc-lite/wasm': major
---

Remove `exportKmz`, which wrapped GLB bytes in a KMZ that Google Earth cannot load. Use `exportKmzFromMeshes`, which embeds the supported COLLADA model format.
