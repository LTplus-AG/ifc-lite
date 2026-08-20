---
'@ifc-lite/geometry': patch
---

`intersection_solid`'s trust gate now projects each operand's extent onto the same axis the overlap thickness is measured along, instead of sizing the required band from the max coordinate magnitude over all three axes. An operand pair offset far from the origin on an axis the measured thickness never touches no longer inflates the trust band and wrongly withholds a genuine near-origin-scale overlap as `BelowKernelResolution`.
