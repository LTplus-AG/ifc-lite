---
"@ifc-lite/wasm": patch
---

Swept disks and surface-curve swept solids now honour `StartParam`/`EndParam` in the directrix's own IFC parametrisation. On a composite directrix the parameter is the running sum of each segment's span (a trimmed line's length, a trimmed arc's angle), so a partial range sweeps the authored extent instead of reading each segment as one unit. On a bare circle or ellipse the parameters are angles in the project's plane-angle unit, so `StartParam 0, EndParam 0.79` sweeps a 0.79 rad arc, not the full ring.
