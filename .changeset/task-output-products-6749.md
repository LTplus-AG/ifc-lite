---
"@ifc-lite/parser": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/viewer": patch
---

Read tasks' output products from `IfcRelAssignsToProduct` (#6749). buildingSMART's construction-scheduling examples link each `IfcTask` to the product it builds this way: the task goes in `RelatedObjects` and the product in `RelatingProduct`. Before this change only `IfcRelAssignsToProcess` inputs were read, so these schedules reached the Gantt with no products. Each task now has `outputProductExpressIds` / `outputProductGlobalIds`, kept separate from the input lists. `taskProductExpressIds` / `taskProductGlobalIds` return inputs and outputs together. The 4D animation, Gantt ↔ 3D selection, the Properties schedule card, charts and product unassign all use both lists. Edited exports write outputs back as `IfcRelAssignsToProduct` and remove the original relation. Cost items assigned to the same product are kept. In sandbox scripts, outputs appear as `OutputProductExpressIds` / `OutputProductGlobalIds`.
