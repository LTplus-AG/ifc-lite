---
"@ifc-lite/create": patch
"@ifc-lite/cli": patch
---

In-store authoring walks, review follow-up (#5249): storeys are enumerated from the edited model (`listStoreys` takes an optional overlay; a deleted storey is no longer listed), a created wall retyped out of the divider set no longer bounds rooms, queued positional edits to containment/aggregation relationships are honoured, and the overlay is snapshotted once per walk. The headless `bim.spaces` backend passes the session's mutation view.
