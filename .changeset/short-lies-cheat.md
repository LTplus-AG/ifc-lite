---
"@ifc-lite/wasm": patch
---

Preserve triangle orientation when rotating flat IFC meshes into viewer coordinates. The rotation preserves handedness, so reversing indices made face winding disagree with the transformed normals and with instanced geometry. Viewer caches created before this correction are invalidated and rebuilt on the next IFC open. Previously exported geometry retains its stored indices and needs regeneration to receive the correction.
