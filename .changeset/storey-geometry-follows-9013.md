---
"@ifc-lite/create": minor
---

Storey edits now drive spacing-dependent geometry (#9013). Walls attached to the storey above, recorded as `IfcLite_StoreyAttachment.TopConstraint` or by Revit's `Constraints` › `Top Constraint`, follow their storey, and their base quantities are kept true. Fixed-height walls keep their height. A stair that lands on a re-levelled storey is refit to whole risers, keeping its identities; `editStairDimensionsInStore` accepts `NumberOfRisers`. A storey added above binds walls drawn attached before it existed. Every late refusal, such as an opening above a wall's new top or a rise that no flight fits, is reported by the dry-run plan before anything is written.
