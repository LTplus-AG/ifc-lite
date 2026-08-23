---
"@ifc-lite/drawing-2d": patch
---

The title block's scale bar was labelled wrong on every export, at every scale.

`effectiveScaleFactor` is millimetres per metre and `scale.factor` is the N of 1:N. They are reciprocal, the renderer divided by whichever it was handed, and `useDrawingExport` hands it the former on every export. A 5 m bar read 0.5 m at 1:100, and 0.1 m at 1:500 where 25 m is right.

A bar too big for its title block now shrinks to a round distance it can honestly span, rather than being clamped to the cell and having its label rounded afterwards — a 120mm preset capped a 5m bar at 3.6m and printed "4m".

One behaviour worth knowing about: on a sheet whose drawing is shrunk to fit by roughly 1000x or more (a ~500 m model at 1:1), no round distance both fits the title-block cell and draws segments wide enough to survive rounding, so the scale bar is omitted. Previously that case drew a cell-filling bar labelled with a nonsense distance, so omitting it is the better outcome — but it is a bar disappearing where one used to be.

Also: a degenerate division count no longer overflows the bar or emits an 11MB group; a NaN or negative `heightMm` no longer reaches the emitted `height=` attribute; and a non-positive, NaN or infinite length or scale draws nothing instead of `<rect width="-10.00">`.
