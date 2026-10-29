---
"@ifc-lite/wasm": patch
---

At `low` and `lowest` tessellation, an `IfcSweptDiskSolid` whose outer radius is at most 20 mm (a bar up to 40 mm in diameter) is swept with a 6-sided (`low`) or 4-sided (`lowest`) ring instead of 12 or 6. The radius is compared in metres, through the file's length unit. Thicker sweeps, and every sweep at `medium` and above, are unchanged. On a 100 MB reinforced-concrete model with about 298 000 bar meshes, `low` drops from 64.5 M to 32.3 M triangles.
