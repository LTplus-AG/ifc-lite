# Registered PDF vectors in the viewer

This acceptance covers the explicit PDF vectors choice within a registered
drawing's Save into model controls. It does not qualify arbitrary PDF pages.
The source is the original CC0 `controlledPdf()` in the viewer test fixtures:
SHA-256 `67fe4a0c1e9a826c84643a67f535bc2efca92505386dc619fb5c90364dd49e54`.
It includes nonzero CropBox coordinates, 90-degree intrinsic rotation, UserUnit 2,
and two differently coloured regions touching the intrinsic page boundary.

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
