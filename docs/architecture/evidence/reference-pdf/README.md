# Rotated PDF reference and annotation acceptance (#4308)

Real WebGPU browser run, 2026-09-09, source `946e60f0d` with the generated
native sampler WASM (`309cbc3f840d6191da1627b44c96d6a0f3de722e777c8868d682aa3f11488978`).
The source is the public HABS Cyclorama floor-plan sheet used in the existing
[PDF acceptance](../pdf-appearance/README.md). The page was rotated 90 degrees,
cropped through the visible crop marquee, and calibrated using its printed
193 feet 4 inches dimension (58.928 metres).

The mounted Author → Appearance workspace placed both horizontal (`xy`) and
vertical (`xz`) independent references. Closing and reopening the dock retained
the PDF rotation, crop, landmarks, and measured span. Hiding, locking, unlocking,
and showing the first reference worked. Save into Model created **HABS plan
annotation** and **HABS facade annotation**. Undo removed only the second IFC
annotation; Redo restored it. Hiding both independent references retained both
saved annotation meshes. Normal IFC + images export produced an IFCZIP.
`redo.json`, `result.json`, and `drawing-registration.json` record this run.

The independent IfcOpenShell 0.8.2 reader ran full EXPRESS validation on that
export with zero errors. Its native geometry engine produced two triangles per
annotation. Independently resolving each indexed UV corner through IFC placement
and units produced exactly the registered world corners (maximum error zero).
The archived PNG's SHA-256 matched the source asset for both owners. See
`independent-plan.json` and `independent-facade.json`.

Reproduce the reader check with the exported archive and committed snapshot:

```sh
python3 ../reference-annotation/verify-export.py annotations.ifczip redo.json \
  'HABS plan annotation' independent-plan.json --reference-index 0
python3 ../reference-annotation/verify-export.py annotations.ifczip redo.json \
  'HABS facade annotation' independent-facade.json --reference-index 1
```

A separate fresh browser loaded that archive and shared it through an isolated
local signed relay. A new guest, another fresh guest after both earlier contexts
closed, and a normal reopen of the room export retained both annotations. Every
oriented triangle corner, UV coordinate, decoded image pixel hash, and clamp
sampler matched. Annotation GUIDs survived as IFCX paths with the expected `/`
prefix. Actual mouse selection of the horizontal annotation passed in all four
sessions; `room-reopened-selected.png` shows the final reopened result.
`room-result.json` records all comparisons. The room transport proof is decoded
pixel equality, not original encoded PNG byte preservation. The relay was local;
this does not assert a deployed production-room test.

Independent references remain registration records, not shared IFC products.
This room acceptance covers the saved annotations. The generated IFCZIP and
room tokens are intentionally not committed.

## Calibrated reference in the 2D canvas

The follow-up browser run includes canvas source `2c0f98359`. After placing the
same two references through the dock, the user-facing Section tool opened its
2D panel. Resizing and **Fit to view**, followed by **Down** and **Front** cuts,
showed the complete rotated/cropped PDF in both views (`drawing-plan.png` and
`drawing-front.png`). This exercises independent references, before creating
IFC annotations.

The run observed the actual Canvas2D `drawImage` transforms while still calling
the original drawing method. `canvas-oracle.json` records those matrices and all
four resulting screen corners, each inside the 950 × 711 canvas. Dividing the
rendered edge lengths by the registered IFC edge lengths gives the same scale
in both directions (difference below 0.000001 pixels/metre). Independently
inverting the recorded PDF-to-raster affine transform maps the chosen printed
dimension to 58.928 metres in both views, within 0.00001 metre. This complements
the independent IFC-reader world-corner check; it does not claim PDF/SVG/DXF
export of these independent canvas references.
