---
"@ifc-lite/wasm": patch
---

Keep a thin residual web between two authored openings (a gap of tens of microns, exposed by #7942) closed. The rectangular fast path keeps its exactly closed cut when coplanar consolidation would open it, and the parametric path now judges closure on exact vertices, so a torn cut defers to that fast path instead of being emitted. An affected host keeps the larger raw cut (per host; 0 of 300 random walls).
