---
"@ifc-lite/drawing-2d": minor
"@ifc-lite/viewer": patch
---

DXF reference-underlay text now lands where the DXF puts it. A multiline MTEXT block is anchored at its insertion point by its attachment (group code 71): top attachment grows down from the point, middle attachment is centred on it, and bottom attachment grows up from it with the last line on the point. Before, every renderer justified the first line and stacked the rest below, so bottom-attached labels hung below their point onto the geometry. The canvas, SVG, PDF and DXF exports and the fit bounds now share one block-offset helper, exported as `dxfTextLineOffset(index, lineCount, valign, height)` with `DXF_TEXT_LINE_HEIGHT_FACTOR` (1.3). The DXF exporter also stacks lines across the text's own direction, so rotated multiline labels no longer step straight down.

TEXT justification is fixed in the parser: Aligned (72 = 3) and Fit (72 = 5) stay left-aligned at their start point 10 instead of starting at the end point 11 (stretching the text to fit between the points is still not implemented), and Middle (72 = 4) is centred vertically as well as horizontally.
