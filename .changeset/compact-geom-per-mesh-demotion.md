---
"@ifc-lite/renderer": patch
---

Compact pages (`?compactGeom`) give up only the meshes an edit is about. Removing an entity takes its triangles off its page without decoding anything; moving, rotating or recolouring entities moves only those entities to the bucket path; a model move moves only that model's meshes; and a page a frame cannot split moves only its own meshes. A mesh the bucket path refuses stays on its page: an edit call that includes it fails (its other meshes have already moved), while edits of every other mesh keep working instead of throwing the same error, and a frame stops asking for it.
