---
"@ifc-lite/viewer": patch
---

With `?compactGeom` on, adding a second model no longer decodes every compact mesh of the primary model on the main thread: the federation merge keeps them compact and they go on drawing from their pages.
