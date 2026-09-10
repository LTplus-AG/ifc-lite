# Frozen original PDF reference acceptance

Actual Chromium/WebGPU journey through the existing Appearance workspace, using
`controlledPdf()` from the viewer PDF fixture helper. The two-page control includes
a rotated CropBox and UserUnit 2. No IFC or raster content was fabricated in the
scene; the normal loader opened the existing two-wall control IFC.

1. Upload the control PDF and register page 1 with two landmarks and 2 m distance.
2. Advance the catalog to page 2. The committed page 1 record, image and placement
   remain identical ([screenshot](source-page-changed.png)).
3. Remove the uploaded source. Resolve the original provider by the saved digest
   and run its actual `vectors` worker job: page 1, view box, UserUnit, rotation and
   document digest still match the saved recipe; decoded operations are present.
4. Edit the registered drawing, change the distance to 3 m and save. Its original
   PDF recipe and image remain unchanged. The editing source has explicit frozen
   lineage, not a mutable PDF catalog slot ([screenshot](edited-original.png)).
5. Use ordinary Undo/Redo and export the drawing registration. Both history states
   are exact; exported provenance matches, allowing JSON's equivalent 0/-0 values.

[Machine evidence](browser.json) contains browser version, source digest, frozen
records, decoded original-page result and exported manifest. The vector probe uses
an identity plane transform to verify decoder ownership only; this is not evidence
of vector geometry placement or an enabled vector annotation UI.

Behavior tests additionally exercise missing-original restore, refusal to bind a
different PDF with the same raster, exact-document re-upload, malformed recipe
atomic refusal, older image-only records, history/source lease release, and late
vector cancellation/disposal/foreign-document responses. Original PDF bytes and
passwords are session-owned and are not embedded in registration JSON.
