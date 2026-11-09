---
'@ifc-lite/viewer': patch
---

An Apple Pencil on iPad no longer reaches both the mouse and the touch controls. iOS Safari sends a Pencil press as pen pointer events and as stylus touch events, so one tap could select twice, a drag orbited twice, and in Measure the mouse path set a distance start while the touch path tapped. The touch controls now own a pen press whose touch events arrive; a pen that sends pointer events only, such as a Wacom or Surface pen on a desktop browser, stays with the mouse controls.
