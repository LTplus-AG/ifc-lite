---
"@ifc-lite/site-context": minor
"@ifc-lite/cli": minor
---

The site context's `buildings` layer: neighbouring swissBUILDINGS3D buildings around the site, read through `@ifc-lite/tiles3d`'s swisstopo preset (injectable `reader`, `fetch` and `cache` under the new `buildings` option), converted to the site frame, wound outward with flat normals, and split into `roof` and `wall` parts (`SiteContextMesh.parts`). Each building is an `IfcBuilding` feature with attributes in `IfcLite_SiteContextBuilding` (`BUILDING_SET`); the model's own building is marked `subject: true` by EGID or footprint overlap (`SUBJECT_MIN_OVERLAP`). Whole buildings touching the site are kept, capped with reported truncation. The GLB carries parts, the subject flag and layer provenance as optional format-1 extras, so older files still decode. `summarizeSiteContext` reports buildings. CLI: `--layers terrain,parcel,buildings`, `--subject-egid`, `--tile-requests`, a subject footprint from the model's element placements, an on-disk tile cache, and buildings in the JSON summary.
