---
"@ifc-lite/drawing-2d": patch
---

Make `SVGExportOptions.padding` (documented as "Padding around drawing in mm") actually affect `SVGExporter.export()` / `.exportPolygons()` output. Since the exporter's original commit, `computeTransform` derived `availableWidth`/`availableHeight` from `padding` and never used them anywhere — the option was a silent no-op regardless of value.

**Behaviour change:** `padding` is now a minimum-margin guarantee. `computeTransform` keeps the caller's exact requested `scale` when the drawing already leaves at least `padding` mm of margin on the chosen paper (the common case, and unchanged from before). When it would leave less than that — or the drawing overflows the paper outright — the effective scale is shrunk (never enlarged) just enough to respect the margin; centring is otherwise unaffected, since padding is applied uniformly on all sides.

`padding` defaults to `20` (mm) in both `export()` and `exportPolygons()`, so **this can change output for callers who never pass `padding` explicitly** — not just callers who pass a non-zero value — whenever their drawing, at its requested scale, is closer than 20mm to the paper edge. `padding: 0` is unaffected except in the pre-existing edge case where a drawing already overflows the paper at the requested scale with no padding at all (previously silently overflowed the page; now clamped to fit).
