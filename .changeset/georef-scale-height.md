---
"@ifc-lite/parser": patch
---

fix(georef): apply IfcMapConversion.Scale to the height axis. Per IFC4x3,
the map conversion scale applies equally to x, y and z, but
computeTransformMatrix and transformToLocal left z unscaled — models whose
source and map coordinate systems use different units placed geometry at
the wrong elevation. (Same fix applied to the Rust GeoReference
local_to_map/map_to_local/to_matrix, released with the crates.)
