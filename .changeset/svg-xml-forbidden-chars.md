---
"@ifc-lite/drawing-2d": minor
---

SVG exports no longer produce ill-formed XML when an IFC string contains a control character. A single shared `escapeXml` now replaces every character XML 1.0 forbids (U+0000-U+001F except TAB/LF/CR, U+FFFE, U+FFFF, lone surrogates) with U+FFFD, and `SVGExporter` and the title-block renderer use it for every text node and attribute. A non-finite entity id omits `data-entity-id`, and the title block routes its layout coordinates through the same non-finite guard as the exporter (`svgNum`). `escapeXml`, `entityIdAttr` and `svgNum` are now exported.
