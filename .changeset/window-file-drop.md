---
"@ifc-lite/viewer": patch
---

Dropping a file anywhere in the viewer window now opens it, not only over the 3D view (#5845). A file dropped on the toolbar, sidebar, status bar or a panel used to be ignored, and over some of that chrome the browser navigated away to the file. The drop overlay now covers the whole window. Panels with their own drop zones keep their drops, and text or link drags are left alone.
