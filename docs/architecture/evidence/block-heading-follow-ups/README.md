# Block heading follow-ups to #6632: evidence

PDFs exported through the viewer's own path (`prepareDocument` + `exportPreparedDocument`, real jsPDF,
real Helvetica metrics) in the bundled Chromium, and what can be read back from their bytes. The preview
screenshots and measurements are from the same Vite dev server in the same Chromium.

Every file here was re-measured on the branch after merging `origin/main` at `73070c2d6` ("branch"), against
that same tree with `apps/viewer/src/lib/document/compose.ts`, `compose-block-title.ts` and
`generate-document-pdf.ts` restored from `origin/main` ("main"). The re-measured `readback.txt` is
identical, line for line, to the first measurement on the pre-merge base `5e15a26e4`. Since #6731 the preview draws the composer's items,
so the preview screenshots now show the composer's heading, and the earlier preview-only fixes to
`BlockHeading.tsx` (one line, point size; old F1 preview and F2) were dropped as superseded; their screenshots
were removed with them.

Commands, each run from the repository root, with the dev server from the first line left running in
another shell. Run the two `EVIDENCE_TAG` lines once on the branch and once on "main" (the three files
above restored from `origin/main`), giving `EVIDENCE_TAG=main` or `EVIDENCE_TAG=branch` to match:

```
pnpm --dir apps/viewer exec vite --port 5178 --host 127.0.0.1 --strictPort
EVIDENCE_TAG=branch EVIDENCE_OUT=docs/architecture/evidence/block-heading-follow-ups node docs/architecture/evidence/block-heading-follow-ups/generate-pdfs.mjs
EVIDENCE_TAG=branch EVIDENCE_OUT=docs/architecture/evidence/block-heading-follow-ups node docs/architecture/evidence/block-heading-follow-ups/preview-shots.mjs
node docs/architecture/evidence/block-heading-follow-ups/readback.mjs docs/architecture/evidence/block-heading-follow-ups > docs/architecture/evidence/block-heading-follow-ups/readback.txt
```

A topic that is not loaded is headed `BCF topic <guid>` and prints its full not-loaded notice as a wrapped
line below (added after review). No file here shows that case; `document.test.ts` asserts it through the
PDF producer at heading size 24.

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

Preview (`f1-topic-main.png`, `f1-topic-branch.png`, measured in the DOM by `preview-shots.mjs`, sheet 560 px wide):

| | main | branch |
|---|---|---|
| heading text | "Fire door in corridor 2.14 is missing its closer and label", whole | "Fire door in corridor 2.14 is missing its clo…" |
| glyphs end, against the strip's right edge | 111.2 px past it | 4.2 px inside it |
| glyphs end, against the sheet's right edge | 73.5 px past it (clipped) | 41.9 px inside it |

## F3: a half-width chart beside a half-width text block, heading size 18, yellow strips (`f3-chart-beside-text-*.pdf`)

| | main | branch | tool |
|---|---|---|---|
| chart strip | x 40 to 289 (249 pt) | x 40 to 293 (253 pt) | `pdftoppm` pixels |
| text strip | x 303 to 555 (252 pt) | x 303 to 555 (252 pt) | `pdftoppm` pixels |
| heading texts | unchanged: 43.0 to 259.1 and 305.6 to 489.7 | same | pdf.js |

The one-pixel difference between 253 and the column's 252.6 is the anti-aliased edge.

## What this does not show

Firefox and Safari (the PDFs are produced in Chromium; the preview was measured there only); a 3D snapshot
beside a topic heading (the PDFs use none); heading glyph shapes other than Helvetica bold.
