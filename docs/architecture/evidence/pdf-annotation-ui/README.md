# Registered PDF vectors in the viewer

This acceptance covers the explicit PDF vectors choice within a registered
drawing's Save into model controls. It does not qualify arbitrary PDF pages.
The source is the original CC0 `controlledPdf()` in the viewer test fixtures:
SHA-256 `67fe4a0c1e9a826c84643a67f535bc2efca92505386dc619fb5c90364dd49e54`.
It includes nonzero CropBox coordinates, 90-degree intrinsic rotation, UserUnit 2,
and two differently coloured regions touching the intrinsic page boundary.

The target reuses the [F5 captured model](../captured-ui/README.md), whose
public boulder source and derivation are credited in the linked evidence.
The browser opens the existing authored-owner IFCZIP through Open, uploads and
calibrates the PDF as a vertical reference, then removes its catalog source.
The saved registration still owns the original document. Save into model → PDF
vectors → Prepare vector preview decodes that original page and prepares both
canonical coloured parts without IFC or main-scene publication. Explicit Create
selects one IfcAnnotation with both parts and no texture assets.

Ordinary toolbar Undo removes the owner; Redo restores both parts. The drawing
reference is hidden independently. File → IFC export writes an IFCZIP, and a
fresh tab opens it through the ordinary loader with no original PDF uploaded.
The reopened annotation retains Name, both colours, four triangles and exact
indexed world-corner association in this control. Actual pointer picking selects
it before and after export. This is a controlled visual-geometry workflow,
not a claim about text, font, arbitrary clipping, transparency or stroke fidelity.

Native qualification and the independent original-PDF/IFC oracle are recorded
separately in [PDF composition lattice](../pdf-composition-lattice/README.md).
The shared authored-owner transaction is covered in
[authored-owner evidence](../authored-owner/README.md). Unsupported pages and
user-cropped references are refused without partially created IFC geometry.


[Native preview](preview.png) shows the explicit representation and tolerance
controls after removing the catalog source. [Created and selected](created-selected.png)
shows the owner restored by ordinary Redo. [Journey measurements](journey.json)
retain the frozen reference recipe, exact indexed world coordinates and colours,
actual pointer locations, browser version and export/reimport results. The
measured maximum world-corner difference is zero for this control.


The UI validation currently passes Node 22.23.2 root Turbo typecheck across all
1,925 test files. Focused tests cover original-PDF/IFC binding and no-publication
preview, late cancellation/input changes/model removal, shared target selection,
existing image creation controls and shared textured/untextured GPU preview.
Final visual reimport acceptance depends on the separately reviewed item-level
3D annotation routing fix tracked by #4459; the initial normal reimport exposed
duplicated symbolic fills despite correct canonical meshes. No screenshot here
claims that separate renderer defect is already resolved.
