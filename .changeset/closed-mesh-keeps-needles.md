---
"@ifc-lite/wasm": patch
---

The f32-collapse degenerate backstop no longer opens a closed mesh. It dropped every triangle whose longest edge exceeds 1e5 times its shortest, which also matched real face triangles: the ISSUE_068 school wall #43810 has two ridge vertices 140 µm apart, so each gable side face carried a triangle with a 140 µm edge and a 21 m edge, and dropping both left 6 open edges. A mesh whose every edge is used exactly once in each direction, bit for bit, is now left alone; such a mesh cannot carry a bit-identical vertex pair or an exactly zero-area triangle, so the f32 collapse the backstop exists for still gets dropped. Over 117 fixture models 22 meshes change, each from open to closed (146 open edges to 0), and no other mesh changes.
