---
"@ifc-lite/create": minor
"@ifc-lite/viewer": patch
---

Save markup into model now includes the 2D drawing's dimensions, and reopening a saved model restores them. `@ifc-lite/create` adds `addDimensionMarkupToStore`, and `addDrawingMarkupToStore` takes `dimensions2D`. A dimension becomes an `IfcAnnotation` tagged `IfcLite:Markup:Dimension` with the dimension as drawn: the dimension line, extension lines, ticks and value text. It keeps the measured value in `Qto_IfcLiteMarkup.Distance`, and its offset, orientation, text override, snapped elements and drawing cut in `Pset_IfcLiteMarkup`. Lengths are written in the model's own unit. A restored dimension keeps its cut, so on another cut it still shows dimmed and stays out of exports.

Saving markup into a reopened model now replaces the dimensions it restored instead of adding a second copy. Restored markup of every kind now comes back at the points it was saved at, no longer mirrored and shifted by the model's storey placement.
