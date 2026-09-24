---
"@ifc-lite/viewer": patch
---

The entity context menu's camera item now frames the right-clicked element instead of zooming out to the whole model (#5597). It is labelled "Frame selection", runs the same framing as the F key, the toolbar and search, and clears any earlier multi-selection first so the camera doesn't frame the old elements. The menu items that have a keyboard shortcut now show it: F, Del, =, +, −, B, and A for "Show all".
