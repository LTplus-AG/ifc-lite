---
"@ifc-lite/charts": patch
---

The `elementCount` chart draws its number again in the SVG export (PDF report, CLI): the ECharts `GraphicComponent` that draws it was never registered, so the card rendered blank (#6464).
