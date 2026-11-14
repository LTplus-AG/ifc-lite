---
'@ifc-lite/viewer': patch
---

Undo and redo for 2D drawing dimensions. While the Dimension tool is active, Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes placing, editing, moving, deleting or clearing dimensions; text fields keep their own undo, and with no dimension change to undo or redo the key goes to the regular workspace undo. History starts fresh when you switch or remove the model, or reset the session.
