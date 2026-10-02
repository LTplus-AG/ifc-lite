# A scaled block stays in the printable frame and pairs the same way at every size (#6681)

Two documents were exported to PDF through the viewer's own path (`prepareDocument` + `exportPreparedDocument`, real jsPDF and svg2pdf, run in headless Chromium against the Vite dev server), once with `main`'s layout code (`f53a4fe16`) and once with the fix. Every number below was read back from the bytes of those files, none comes from the composer.

| File | What it is |
| --- | --- |
| `finding1-landscape-snapshot-200-{main,branch}.pdf` | A4 landscape, one chart with a snapshot, block size 200 % |
| `finding2-two-half-charts-150-{main,branch}.pdf` | A4 portrait, two half-width charts of height 600, block size 150 % |
| `finding{1,2}-{main,branch}-page1.png` | Page 1 of each, rasterised with `pdftoppm -r 50 -png -f 1 -l 1` |
| `snapshot-stub.png` | The 64 x 48 solid PNG the stub snapshot capture returns |
| `generate-pdfs.mjs`, `readback.mjs`, `readback.txt` | The commands below, and the read-back output |

## Commands

```
pnpm --filter @ifc-lite/viewer exec vite --port 5178 --host 127.0.0.1 &      # with main's compose.ts, DocumentPreview.tsx, BlockEditor.parts.tsx
EVIDENCE_TAG=main   EVIDENCE_OUT=<dir> node docs/architecture/evidence/block-scale-frame-6681/generate-pdfs.mjs
# restart Vite on the fix
EVIDENCE_TAG=branch EVIDENCE_OUT=<dir> node docs/architecture/evidence/block-scale-frame-6681/generate-pdfs.mjs
node docs/architecture/evidence/block-scale-frame-6681/readback.mjs <dir>
```

The chart is a count by specification of a seeded IDS validation report. The real 3D snapshot needs the renderer, which headless Chromium here has no GPU for, so the snapshot capture is a stub returning `snapshot-stub.png`; it is placed by the same `addImage(png, 'PNG', x, y, w, h)` call a real capture is, so its box in the PDF is the box the composer chose. The picture inside the box is not a model.

## Read back from the PDFs

Tools: `pdfinfo` gives the page count and size, `pdftotext -bbox` gives word boxes, and pdf.js 6.3.289 (the viewer's own `pdfjs-dist`) gives the image box: the current transform at each `paintImageXObject` in the page's operator list. Points, from the top-left of the page. The printable frame is the document's: 40 pt margins, a 30 pt header and a 24 pt footer, so on A4 landscape it ends at 595.28 - 64 = 531.3 and on A4 portrait at 777.9.

| Document | Fact | `main` | Fix | Tool |
| --- | --- | --- | --- | --- |
| Finding 1, A4 landscape, 200 % | Pages | 1 | 1 | `pdfinfo` |
| | Snapshot box (x, y) | x 40.0 to 801.9, y 234.0 to 594.0 | x 508.0 to 801.9, y 134.0 to 494.0 | pdf.js operator list |
| | Against the frame bottom 531.3 | crosses it by 62.7 pt: it runs over the footer to 1.3 pt from the page edge (595.28) | inside it, 37.3 pt to spare | arithmetic on the row above |
| | Arrangement | stacked under a flattened plot, as wide as the column | beside the plot, as at 100 % | page raster, `finding1-*-page1.png` |
| Finding 2, A4 portrait, 150 % | Pages | 2 | 1 | `pdfinfo` |
| | Title "Chart A" | page 1, x 40.0 to 99.6 | page 1, x 40.0 to 99.6 | `pdftotext -bbox` |
| | Title "Chart B" | page 2, x 40.0 to 99.6 | page 1, x 302.6 to 362.2 | `pdftotext -bbox` |

The 62.7 pt agrees with what the composer reports for the same document, which is the check that the composer and the bytes tell the same story; the numbers in the table are the bytes'.

## What this does not show

- Only Chromium. The preview is not part of these files.
- The snapshot is a stub image, not a render of a model.
- The chart's own vector box (svg2pdf draws it as paths) was not measured; its labels and title were, through the word boxes. The rotated axis labels of a narrow chart extend left of the chart in both versions; that is not part of this change.
