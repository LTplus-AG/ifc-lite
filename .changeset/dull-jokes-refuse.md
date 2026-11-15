---
"@ifc-lite/renderer": minor
"@ifc-lite/lists": minor
---

Expose numeric per-object triangle counts in lists and model/object information, counting every instanced occurrence without expanding its geometry. Keep compact metadata through CPU geometry release and update subscribers when topology changes.

Renderer hosts publish completion with `setTriangleCountReplayComplete(true)` only after supplying the complete source snapshot, and can query `isTriangleCountReplayComplete()`. A new Scene, cleared source, or source append invalidates the receipt; viewer inspector/list counts remain unavailable during partial replay.
