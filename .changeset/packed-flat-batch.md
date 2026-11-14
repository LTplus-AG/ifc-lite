---
"@ifc-lite/geometry": patch
---

Geometry workers send a flat batch's positions, normals and indices as one buffer per stream instead of three buffers per mesh. The main thread gives each mesh views of them, so the pool's message handler deserializes a few buffers per batch instead of about 1,200 typed arrays and buffers. Every other mesh field travels as before, and the delivered `MeshData` keeps its shape and values. A mesh whose arrays are referenced elsewhere (`entityIds`, a non-identity `appearanceSource`) still travels whole.
