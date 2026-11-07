---
"@ifc-lite/renderer": patch
---

Make owned annotation lines, fills and text labels pickable through both GPU and large-model CPU selection. Preserve clipping, visibility, camera-relative precision and upload lifecycle semantics. Anchored line partitions accept one `ownerIds` entry per segment; symbolic fill and text inputs accept `ownerId`.
