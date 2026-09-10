---
"@ifc-lite/viewer": patch
---

Open glTF 2.0 scan bundles by selecting the .gltf document with its local .bin and PNG/JPEG resources. The bounded resolver rejects missing, remote, traversal, and ambiguous resources, then feeds a self-contained GLB through the existing model loader.
