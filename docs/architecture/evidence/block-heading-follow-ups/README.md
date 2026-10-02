# Block heading follow-ups to #6632: evidence

PDFs exported through the viewer's own path (`prepareDocument` + `exportPreparedDocument`, real jsPDF,
real Helvetica metrics) in the bundled Chromium, on `upstream/main` at `5e15a26e4` ("main") and on this
branch ("branch"), and what can be read back from their bytes. The preview screenshots and measurements are
from the same Vite dev server in the same Chromium.

Commands (the "main" files are produced by restoring the three changed source files of `src/lib/document/compose.ts`,
`compose-block-title.ts` and `components/viewer/document/BlockHeading.tsx` from `upstream/main`):

```
cd apps/viewer && pnpm exec vite --port 5178 --host 127.0.0.1 --strictPort
EVIDENCE_TAG=main|branch EVIDENCE_OUT=docs/architecture/evidence/block-heading-follow-ups node docs/architecture/evidence/block-heading-follow-ups/generate-pdfs.mjs
EVIDENCE_TAG=main|branch EVIDENCE_OUT=docs/architecture/evidence/block-heading-follow-ups node docs/architecture/evidence/block-heading-follow-ups/preview-shots.mjs
node docs/architecture/evidence/block-heading-follow-ups/readback.mjs docs/architecture/evidence/block-heading-follow-ups > readback.txt
```

Tools: `pdfinfo` (page size), `pdftotext -bbox` (word boxes), pdf.js 6.3.289 `getTextContent` (item position
and width), `pdftoppm -r 72` (the yellow strip is the run of `#ffff00` pixels, one pixel per point). `mutool`
and `qpdf` are not installed. Nothing in `readback.txt` comes from the composer. No 3D snapshot is involved.

## F1: a topic's own title, heading size 24, yellow strip (`f1-topic-fallback-title-*.pdf`)

| | main | branch | tool |
|---|---|---|---|
| strip | x 40 to 555, 35 pt tall | same | `pdftoppm` pixels |
| heading text ends at | 597.9 pt, "Fire door in corridor 2.14 is missing its closer an" | 551.2 pt, "Fire door in corridor 2.14 is missing its clo…" | pdf.js `getTextContent` |
| against the right margin edge (555.3) | past it by 42.6 pt, and past the page edge (595.3) | inside it | pdf.js |
| last word box | "an" 569.9 to 597.9 | "clo…" 492.5 to 551.2 | `pdftotext -bbox` |

Preview (`f1-topic-main.png`, `f1-topic-branch.png`, measured in the DOM): the heading box is 32.83 px tall on
both; the text needs 66 px on main (`white-space: normal`, two lines overlapping "Status: Open") and 33 px on
the branch (`white-space: nowrap`).

## F3: a half-width chart beside a half-width text block, heading size 18, yellow strips (`f3-chart-beside-text-*.pdf`)

| | main | branch | tool |
|---|---|---|---|
| chart strip | x 40 to 289 (249 pt) | x 40 to 293 (253 pt) | `pdftoppm` pixels |
| text strip | x 303 to 555 (252 pt) | x 303 to 555 (252 pt) | `pdftoppm` pixels |
| heading texts | unchanged: 43.0 to 259.1 and 305.6 to 489.7 | same | pdf.js |

The one-pixel difference between 253 and the column's 252.6 is the anti-aliased edge.

## F2: the preview heading's size (`f2-unset-*.png`, `f2-size12-*.png`)

Measured in the DOM, a table block's heading:

| | main | branch |
|---|---|---|
| title set, size unset | 14.00 px font, 20.00 px box | 10.35 px (11 pt at the sheet scale), 15.05 px box |
| size 12 | 11.29 px font, 16.41 px box (smaller than unset) | 11.29 px, 16.41 px |

## What this does not show

Firefox and Safari (the PDFs are produced in Chromium; the preview was measured there only); a 3D snapshot
beside a topic heading (the PDFs use none); heading glyph shapes other than Helvetica bold.
