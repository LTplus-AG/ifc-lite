---
"@ifc-lite/viewer": patch
---

Saving 2D drawing markup into a model no longer duplicates markup the file already carried. When a model saved with markup was reopened and its markup restored, "Save markup to model" added a second copy of every annotation. The save now replaces the IfcLite markup annotations from the file whose content the session actually loaded (restored from the file, or restored from this browser's saved drawing for the same file when that drawing was itself seeded from the file's markup). It removes their representation, placement, property and quantity sets and relationships too. Embedded markup the session never loaded, for example because you drew before the restore finished, is kept, and the new markup is written beside it. Geometry other elements share and annotations from other tools are kept. Saving with no markup left removes only markup the session loaded.

Saved drawings in this browser now record which embedded annotations they loaded. Drawings saved by earlier versions do not have this record, so a save from them replaces no embedded markup and writes beside it, as before. A saved drawing with no markup that does not record loaded annotations (written by a display-option change before the file's markup restored) no longer stops the file's embedded markup from being restored. This includes such drawings saved by earlier versions.
