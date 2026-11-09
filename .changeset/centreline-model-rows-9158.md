---
"@ifc-lite/viewer": patch
---

Measure Point stays "Live" when a model row changes but the selected centreline doesn't move: collapsing, expanding or renaming a model, or showing or hiding a model that holds no selected product, no longer clears and rebuilds the centreline and its snap curves. Hiding or removing the model of a drawn product, and a change to a model's geometry, alignment, georeference or source, still clear them before the next frame (#9158).
