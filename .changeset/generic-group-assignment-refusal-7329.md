---
"@ifc-lite/create": minor
"@ifc-lite/viewer": minor
---

`updateGroupInStore` now refuses complete membership replacement when a group has typed `RelatedObjectsType` assignments or several assignment relationships with distinct OwnerHistory, Name or Description, instead of merging their meanings into one relationship. Such groups can still be read and safely removed. The viewer Assistant can review generic IfcGroup create, update and remove proposals from attached selection evidence, apply them through the native owner with one Undo, and reports complete Group facts that exceed the transport budget as unavailable rather than truncating them. Selection evidence and attachments skip the whole-model Group graph when the selection touches no exact IfcGroup: they carry bounded create-only facts (`scope: "no-group-context"`, from `readGroupCreateEvidenceInStore` in `@ifc-lite/create`), and review still checks the complete graph. Models over the graph's entity budget are refused on both paths before any record is decoded; the per-record budget refuses a source record when its export text is measured.
