# Block size (#6548): one factor for a block's text and graphics

The viewer was run (Vite dev server, headless Chromium, `building-architecture.ifc` loaded). A document of four blocks was built (a heading, a body paragraph, a chart of the loaded model and an IDS report with its ring), the **Block size (%)** field of each block was set through the real input, and the PDF was produced by the viewer's own `prepareDocument` + `exportPreparedDocument` (real jsPDF and svg2pdf, no recording seams).

Files:

| File | What it is |
| --- | --- |
| `block-size-100.pdf`, `block-size-150.pdf`, `block-size-75.pdf` | The exported PDFs at the default size, 150 % and 75 % |
| `pdf-100.png`, `pdf-150.png`, `pdf-75.png` | Page 1 of each, rasterised with `pdftoppm -r 70` |
| `viewer-100.png`, `viewer-150.png` | The Document panel (editor with the new field, and the preview) at 100 % and 150 % |

## Measured in the PDFs

`pdftotext -bbox` word boxes of the real PDFs. Heights are in points; `plot span` is the distance between the chart's axis labels `4` and `0`, i.e. the height of the plotted area. Page header, footer and page number are not block content and stay at 8 pt.

| Block size | Heading text | Body text | Chart title | Chart axis label | Chart plot span |
| --- | --- | --- | --- | --- | --- |
| 100 % (default) | 12.03 | 9.25 | 10.18 | 11.10 | 114.84 |
| 150 % | 18.04 (x1.500) | 13.88 (x1.501) | 15.26 (x1.499) | 16.65 (x1.500) | 172.26 (x1.500) |
| 75 % | 9.02 (x0.750) | 6.94 (x0.750) | 7.63 (x0.750) | 8.32 (x0.750) | 86.13 (x0.750) |

At 150 % the body paragraph wraps into three lines instead of two (the text re-flows in the same column at its larger size), and the page still fits on one sheet.

## What this does not show

- The preview was captured in Chromium only. The preview scales blocks with the CSS `zoom` property (Chromium, Safari, and Firefox 126 or later); the PDF does not depend on it.
- Only a chart, text and an IDS report were exported here. Tables, topics, images and the manual-validation report are covered by the composer unit tests (`document-scale.test.ts`), not by a browser run.
