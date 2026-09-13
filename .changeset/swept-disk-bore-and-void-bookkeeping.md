---
"@ifc-lite/wasm": patch
---

Mesh `IfcSweptDiskSolid` side walls facing outward (they faced into the tube while the caps faced out) and cut `InnerRadius` as a bore instead of meshing a hollow pipe as a solid rod. Also: the batched void cut keeps a welded cutter in its batch after the host has already been cut, the silent-no-op diagnostic counts rectangular openings the same way on every cut path, a layer part nested under a geometry-less assembly is skipped by the merge-layers toggle like a direct child, and a withheld clash pair reports the axis that actually failed the resolution check, so its thickness is always below the required band.
