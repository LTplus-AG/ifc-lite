---
"@ifc-lite/wasm": minor
---

Convert qualified positive-pattern dashed PDF strokes on closed straight subpaths into styled IFC annotation fill geometry. The closing edge continues the dash cycle, with capped closure seams for PDF 1.0–1.7 and joined first/last on-dash pieces for PDF 2.0. Unknown versions and PDF 1.x single-dash full loops remain explicit omissions. Explicit close-path and close-and-stroke operators share the behavior, including paths that mix open and closed subpaths.
