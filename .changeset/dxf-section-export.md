---
'@ifc-lite/drawing-2d': minor
---

Add a DXF exporter (`DXFExporter` / `exportToDXF`) alongside the existing SVG exporter, plus a low-level ASCII DXF writer (`DxfWriter`, `sanitizeDxfLayerName`) and a `cssToAci` CSS-to-AutoCAD-Color-Index helper.

`exportToDXF` mirrors `exportToSVG`'s `Drawing2D` + reference-underlay input contract (same polylines/edges, hatch-boundary polygons, text/annotations, and per-style layers) and writes ASCII DXF AC1015 (R2000): HEADER (`$INSUNITS` = metres), TABLES (LTYPE, LAYER), ENTITIES (LWPOLYLINE/LINE/TEXT). Hatched cut polygons are represented as closed LWPOLYLINE boundaries on a dedicated layer rather than a HATCH entity. An optional `coordinateTransform` lets a caller re-derive world/map coordinates before points reach the writer (used by the viewer's "Download DXF" section-panel export, issue #1861, to georeference plan sections).
