---
'@ifc-lite/drawing-2d': major
'@ifc-lite/sdk': major
---

Fix `getRecommendedScale`, which returned a wrong scale on every call.

Two independent defects, producing opposite wrong answers:

- The bounds are metres and the paper is millimetres, and nothing converted
  between them. Every model smaller than 378 m fitted at 1:1.
- The SDK wrapper passed one argument to a function taking two, so the height
  arrived `undefined`. Every `<=` against NaN is false, so the loop fell
  through the whole table and returned the coarsest entry: 1:1000 for every
  drawing, whatever its size.

`bim.drawing.getRecommendedScale` now accepts the height and an optional paper
size, all optional, so existing single-argument calls keep working. Passing
only a width squares the extent and costs one to two steps of coarseness on an
elongated plan, so pass the height when you have it. Paper size was previously
unreachable through the SDK, which meant A1 and A4 could not be asked for.

A non-finite or non-positive input now throws instead of silently returning
the coarsest scale. That narrows the accepted input domain of a published
API, which is why this is major: a caller passing 0 from a degenerate
bounding box used to get 1:1000 back and now gets an exception, and the SDK
wrapper forwards the throw with no catch. Adding the optional height and
paper-size arguments is additive on its own, but the narrowed domain is the
biggest change here and sets the level.

Not changed, and worth knowing: the scale table stops at 1:1000, so a model
larger than roughly 378 x 267 m still gets 1:1000 even though it does not fit.
