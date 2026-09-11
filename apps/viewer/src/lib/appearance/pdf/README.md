# PDF appearance source (F2 / #4260)

This browser service turns one selected PDF page/crop into a PNG in the existing
AppearanceAssetInventory. It does not create IFC annotations, reference planes,
semantic objects, or calibrated IFC projections. Those consume the returned
source metadata through the existing authoring workflow.

Development requires Node 22.13 or newer within Node 22, or Node 24, matching
the PDF.js engine requirement and the repository's supported Node versions.

## Integration

Lazy-import `PdfAppearanceSource` when the user chooses a PDF. Call
`PdfAppearanceSource.open(file, inventory, {signal,password})`, then `page(n)` or
`rasterize({pageNumber,rotation,cropPoints,dpi},{signal})`. Additional rotation is
clockwise relative to the PDF page's intrinsic rotation. Crop coordinates are
`[left,top,width,height]` in the rotated visible page, measured in physical PDF
points (1/72 inch). `paperSizeMetres` describes paper only; a drawing's printed
1:100 label is not applied automatically. User calibration remains a distinct
model-space operation.

The raster recipe includes native CropBox/UserUnit/rotation, PDF→page and
pixel→PDF transforms, requested/effective DPI, crop, and pixel dimensions. Budget
reduction changes raster resolution, not the calibrated physical page size.
Do not infer physical size from the PNG header or stretch a page per IFC object.

Each result has a session `sourceId`, a content-derived `documentId`, and its
complete page/crop recipe, separately from `asset.id`. Image deduplication may
reuse identical PNG bytes for unrelated pages or documents. A future source UI
must keep `sourceId` and that lineage; using the image digest as its source key
would discard calibration and provenance.

The source owns original PDF bytes/password only in this session. Its derived
PNGs have independent source-owner leases in the shared image inventory. Retain
the image under the normal draft/model/history owner before removing the source;
`dispose()` cancels work, releases its source image leases, and drops PDF bytes.
Only the derived PNG enters ordinary IFCZIP/model asset export. An IFCZIP is not
a backup of the editable PDF document. Password-required and password-incorrect
errors are typed; retain the selected File in the UI while prompting for retry.

## Decoder and limits

Pinned PDF.js `pdfjs-dist` 6.3.289, Apache-2.0. Parsing/rasterization is lazy and
runs inside a dedicated cancellable worker; cancellation terminates the job,
including stalled decoding. Only a selected page is rendered. File size, page
count, output/intermediate pixels, dimensions and runtime have limits; these do
not constitute a hard VM memory limit on arbitrary compressed PDF streams.

PDF.js receives `stopAtErrors`, XFA disabled, bounded image size, and bundled
CMaps/standard fonts/image-decoder resources. No document JavaScript actions are
invoked. No PyMuPDF dependency is used. The
worker uses OffscreenCanvas with font outlines. Pages requiring DOM SVG color,
alpha, luminosity or knockout filters reject explicitly rather than silently
producing a different appearance. Complex documents need real-page comparison;
PDF rasterization does not imply editable vector/font/annotation support.

Primary references checked 2026-09-09:

- https://mozilla.github.io/pdf.js/examples/
- https://mozilla.github.io/pdf.js/api/draft/api.js.html
- https://www.npmjs.com/package/pdfjs-dist
- https://github.com/mozilla/pdf.js/blob/master/LICENSE

## Evidence

Actual PDF.js tests generate an original CC0 two-page PDF with CropBox,
90-degree intrinsic rotation and UserUnit=2; verify page selection, paper scale
independent of DPI, extra rotation/crop, bounded raster output, encrypted PDF
password diagnostics, malformed input and cancellation. Worker orchestration
and source/image ownership tests exercise stale results and teardown.

A fresh actual Chromium tab on the viewer dev server rendered that document
through the production worker to a 144×200 PNG at 72 DPI. The earlier controlled
PDF with font outlines and vector labels also rendered to 612×396 pixels.
The production source-document→inventory path also verified exact red/green
orientation markers, PNG-only export resources, retention after PDF removal
while a model owner remains, and final release after that model owner leaves.
This is service-level browser evidence; the integrated F2 calibration and
projection journey is not yet established by these runs.

The same worker also accepts a `vectors` job. Its pinned PDF.js adapter produces
ordered decoded operations for `IfcAPI.preparePdfVectorPage`; it neither writes
IFC nor independently interprets geometry. It never rasterizes a vector job.
Original source bytes remain attached to their owner, and document/page cleanup
uses the same `finally` path as inspect/raster jobs. See the
[canonical preparation contract](../../../../../../docs/architecture/pdf-vector-annotations.md#bounded-graphics-state-preparation).
