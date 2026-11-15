---
"@ifc-lite/viewer": patch
---

Same-CRS alignment of a large inline point cloud no longer calls a closure per point, and cross-CRS alignment counts cloud points in its attempt and failure tally, as it does mesh vertices (#10094, item 3f).
