---
"@ifc-lite/viewer": patch
---

Agent authoring operations write where they say and refuse instead of reporting a no-op. A Rectangle default profile sets the kind's Width and Height (Depth for a column), a zero SillHeight is accepted, storey add planning and `storeys.topConstraint` work in the viewer, and placement, default-pick, zone and change selection operations no longer act on another model's state or on unknown targets.
