---
"@ifc-lite/viewer": patch
---

The entity context menu no longer slides under the ribbon. It rendered in place, early in the layout, at the same layer as the ribbon, so a menu pushed against the top edge had its header (entity name and type) painted over by the toolbar. The menu and its submenus now portal to the document body like the other menus. They are also capped to the space left in the window and scroll, so in a short window the last rows ("Export anonymized…", "Delete entity") stay reachable instead of running past the status bar.
