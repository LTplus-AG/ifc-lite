---
"@ifc-lite/parser": patch
---

`CostItemInfo.productExpressIds`/`productGlobalIds` no longer include a task,
resource or actor assigned to a cost item via `IfcRelAssignsToControl`. That
relationship legitimately binds those objects too, not just products, so the
branch previously pushed every related object into fields documented (by
name) as an `IfcProduct` view with no type check (#4877). The branch now
filters related objects to `IfcProduct` subtypes, matching the sibling
`IfcRelAssignsToProduct` branch, which already only ever pushed a product.
This is a bug fix, not a rename: the field names, types and shape are
unchanged, and no consumer in this repo currently reads either field. A
downstream consumer that was relying on the previous (undocumented,
type-unfiltered) behaviour will see fewer entries in these two arrays.
