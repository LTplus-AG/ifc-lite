---
"@ifc-lite/viewer": patch
---

Stop the Drawing Sheet PDF export asking the browser for a canvas it will not allocate, and never let a blank one reach the page.

The sheet PDF rasterizes `generateSheetSVG`'s output at a fixed 300 dpi, sized to the sheet's own paper. On the big papers that is far past what WebKit allocates: ARCH E (1219.2 x 914.4 mm) is 14400 x 10800 = 155,520,000 px, A0 is 14043 x 9933 = 139,489,119 px, against `CanvasBase::maxCanvasArea()` — `8192 * 8192` on the iOS family, `16384 * 16384` elsewhere. Nine of the twenty-five registry paper sizes are over the lower cap; ARCH E, not the A0 named in review, is the worst case.

Nothing about that failure announces itself. `CanvasBase::validateArea()` logs a console warning and returns false, the canvas gets no backing store, `getContext('2d')` still hands back a live context, the paint calls no-op, and `toDataURL()` returns the literal string `"data:,"` (`encodeDataURL(RefPtr<ImageBuffer>&&)` returns `"data:,"_s` for a null buffer). The export then died inside jsPDF's PNG decoder, so the user got a complaint about a PNG signature with no remedy in it.

The pixel grid now comes from `fitRasterPixels` — the same helper the 3D-view PDF's shaded underlay already uses, rather than a second cap policy — budgeted at WebKit's lower cap. It scales both sides by one factor, and the image is still placed across the full paper rectangle in millimetres, so a capped sheet is blurrier and never mis-scaled: A0 lands at 208 dpi and ARCH E at 197, both above the 150 dpi this repo already ships as adequate for a printed PDF raster. Papers inside the cap — ARCH C and everything smaller, including the A3 default — are untouched at the full 300 dpi.

Capping is surfaced, not silent: a reduced sheet raises a notice naming the dpi actually delivered and pointing at the SVG export for a vector sheet at any size. And because a pixel budget is necessary but not sufficient — Safari enforces a separate total canvas-memory limit, and any browser can fail a large allocation on a low-memory device — a data URL that is not a PNG is now refused with a message that names the paper size and the way out, instead of being handed to jsPDF.

The cap value and the failure mode are read off WebKit's source, not observed in a browser; no Safari, Chrome or Firefox was run, and Chrome's and Firefox's own limits are not modelled.
