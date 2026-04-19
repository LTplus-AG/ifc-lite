---
"@ifc-lite/wasm": patch
---

Subtract voids per sub-mesh so multi-layer walls keep their layer colours after opening cuts (#541). Previously merging the void subtraction onto the combined mesh collapsed all per-item style information, so doors and windows in material-segmented walls came out uniformly coloured.
