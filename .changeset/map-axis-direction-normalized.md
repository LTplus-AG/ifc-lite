---
"@ifc-lite/viewer": patch
---

Treat `IfcMapConversion` XAxisAbscissa/XAxisOrdinate as the direction they specify. The vector's length is no longer applied as an extra map scale: the Location pin and footprint, the Cesium model origin and rotation, the placement gizmo and the pick readout now agree for axis (1,0) and (2,0). `Scale` and the `IfcMapConversionScaled` factors still apply exactly once, and authored axis values are read and exported unchanged. A zero-length axis now has no pin, footprint or Cesium placement, as a non-finite one already did.
