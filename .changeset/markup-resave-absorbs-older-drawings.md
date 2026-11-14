---
"@ifc-lite/viewer": patch
---

Saving 2D drawing markup into a model no longer duplicates the file's markup when the drawing was saved in this browser by an earlier version. Such a drawing does not record which of the file's annotations it loaded, so "Save markup to model" used to write its markup beside the file's own copy. When that drawing is restored, every item it read from one of the file's IfcLite markup annotations now counts as loaded, so the save replaces that annotation. Only items that name an IfcLite markup annotation present in the opened file count. Anything else in the file is kept, and the drawing records the result from then on.
