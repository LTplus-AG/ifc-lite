---
'@ifc-lite/viewer': patch
---

Fixed the section/plan SVG export writing a graphic-override rule's `fillColor`/`strokeColor` straight into a `fill="…"`/`stroke="…"` attribute with no XML escaping. Every other user-derived string reaching this writer (IFC type, annotation text, DXF layer names) already went through `escapeXml`; the override-rule colors did not. A color value containing `"` — reachable through the free-text color input next to the swatch in the drawing settings panel's graphic-override rules — closed the attribute early, letting the rest of the string parse as markup: the exported file was not well-formed XML and, opened directly in a browser, could execute an injected `<script>` element. Both the direct SVG export and the sheet (paper) SVG export shared the same gap; both are now escaped.
