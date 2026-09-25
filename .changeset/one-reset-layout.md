---
"@ifc-lite/viewer": patch
---

"Reset layout" (activity-bar menu and command palette) now resets the whole workspace: the sidebar, every floating panel, the hierarchy pane and the bottom strip's height. It used to reset only the sidebar. Free-floating panels are now kept inside the window when drawn, so a panel saved on a bigger screen, or before the window shrank, can no longer end up out of reach with its close button off screen.
