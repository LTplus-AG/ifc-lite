---
'@ifc-lite/ids': minor
---

Add MATERIAL_UNRESOLVED failure type to distinguish materially-associated elements whose material attributes are unreadable on server-parsed stores (issue #5227). Modify `checkMaterialFacet` to match the classification facet's handling: surface MATERIAL_UNRESOLVED instead of MATERIAL_MISSING/MATERIAL_VALUE_MISMATCH when an unresolved marker exists that could have matched the constraint.
