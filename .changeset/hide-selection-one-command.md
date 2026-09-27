---
"@ifc-lite/viewer": patch
---

"Hide selection" now behaves the same on every surface. Del, Backspace and
Space, the ribbon, the classic toolbar, the palette, the mobile toolbar and the
context menu all hide every selected entity, then clear the selection.
Previously the keys kept the hidden entities selected, the mobile toolbar hid
only one of them, and the context menu hid only the entity it was opened on.
The context menu still hides just the right-clicked entity when that entity is
outside the selection.
