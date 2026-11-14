---
"@ifc-lite/create": patch
---

`editStructuralEntityInStore` accepts `IfcConnectionPointEccentricity`, the `ConnectionConstraint` of a structural member connection, so `EccentricityInX/Y/Z` can be edited. `removeStructuralEntityInStore` still refuses it: remove the relationship that owns it.
