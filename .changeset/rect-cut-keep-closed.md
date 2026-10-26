---
"@ifc-lite/wasm": patch
---

Keep a thin residual web between two openings (a gap of tens of microns, exposed by #7942) closed. The rectangular fast path keeps its exactly closed cut when coplanar consolidation would open it. The parametric and bool2d paths now check closure on exact vertices instead of a 0.1 mm weld, so a torn cut falls through to the next path. Across all 122 test models (401,624 meshes), one mesh changes: the reported covering, now closed and matching IfcOpenShell. Not fixed here: rotated walls with such a web, and the staged bool2d gate, which still uses the 0.1 mm weld.
