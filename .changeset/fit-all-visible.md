---
"@ifc-lite/viewer": patch
---

Fit All now frames what is visible (#5884). It used to frame every mesh ever loaded, including hidden elements, geometry outside the current isolation, storey or class filter, and every model toggled invisible, so isolating one storey and pressing Fit All still framed the whole building. It now frames the visible elements where they are (a moved model included), still leaving a stray far-away element out of the frame as the load-time fit does. The toolbar button, the Z shortcut, F with nothing selected and the SpaceMouse fit button all use this one Fit All. Home still frames the whole project.
