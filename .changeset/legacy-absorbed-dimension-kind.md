---
"@ifc-lite/viewer": patch
---

An old 2D-drawing localStorage entry (written before the absorbed set existed) now absorbs its embedded-origin dimensions: an `ifc-dimension-N` item whose `N` is a live `IfcLite:Markup:Dimension` annotation is replaced by the next "save markup to model" instead of written beside it. An id naming an annotation of another kind still absorbs nothing.
