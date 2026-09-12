---
"@ifc-lite/wasm": minor
"@ifc-lite/viewer": patch
---

PDF vector conversion (F8, #4406) is now fidelity-gated. `IfcAPI.preparePdfVectorPage` returns a canonical `fidelity` report beside the convertible paths — omission kinds (text, images, clipping, transparency, patterns and shadings, dashes, round caps/joins, curved strokes, hairlines, hidden optional content, annotation appearances, unknown operators) with counts, page-space extents and visibility, plus `exact`, `rasterOnly` and a digest binding the verdict — replacing the previous `stateQualified`, `geometryReady`, `pendingGeometry` and `diagnostics` fields. `IfcAPI.planPdfFillAnnotation` takes `propertySetGlobalId`, `propertyRelationGlobalId` and `acceptedFidelitySha256`: an exact page plans directly, a page with visible omissions plans only when the request quotes the digest of the displayed report, a raster-only page refuses, and every created annotation carries an `IfcLite_PdfVectorConversion` property set recording the source PDF digest, page, CropBox, UserUnit, rotation, decoder, calibration, tolerance in metres and the accepted verdict. The decoder wire format adds typed `clip`, `text`, `image`, `shading`/pattern, `graphicsState`, form/group/annotation scope and marked-content operations.

The viewer's PDF vectors representation shows the report before preparing geometry: exact pages continue, partial pages need the "Create a partial conversion" acknowledgement, and raster-only pages disable the action with a raster-reference message.
