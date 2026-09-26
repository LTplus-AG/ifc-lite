---
"@ifc-lite/viewer": patch
---

While a model loads, the viewport now shows a loading card with the file name, the current phase and a percentage, and a **Cancel** button. Cancelling a model load stops it and returns the viewer to its empty state, with no error; the status bar's Cancel (which used to cover only point-cloud streams) now cancels model loads too. The ribbon, classic and mobile toolbars read their load progress from the same selector as the card.
