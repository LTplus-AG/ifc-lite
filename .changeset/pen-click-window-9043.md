---
'@ifc-lite/viewer': patch
---

A trackpad or mouse click, double-click or right-click right after an Apple Pencil tap, at the same spot, is no longer dropped. The viewer ignores the click a Pencil tap leaves behind for 700 ms, and that window caught genuine clicks too, because a double-click carries no pointer type. A mouse or trackpad press at that spot now closes the window, since only a genuine click starts with one.
