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


The UI validation passes Node 22.23.2 root Turbo typecheck across all
1,926 test files. Focused tests cover original-PDF/IFC binding and no-publication
preview, late cancellation/input changes/model removal, shared target selection,
existing image creation controls and shared textured/untextured GPU preview.
The final combined browser run includes the separately reviewed item-level
3D routing fix. [Unselected fresh import](reopened-colours.png) displays exactly
the two intended coloured regions. [Pointer selection](reopened-selected.png)
selects the imported IfcAnnotation. The actual GPU symbolic fill pipeline is
empty while the 2D cache retains both fills: owner 92, items 77 and 86, matching
the two native mesh parts. The harness binds the cache getter once and waits
with a synchronous predicate before inspecting either pipeline.

The combined root build passes all 51 tasks. Its freshly generated WASM digest,
source checkpoint, output IFCZIP digest and browser/runtime identity are recorded
in `journey.json`. This control establishes the integrated workflow; the broader
PDF fidelity work remains tracked by #4406.


To repeat the full UI journey, run `browser-proof.mjs` from the repository root
with `PROOF_TARGET_IFCZIP` pointing at the same F5 target and `PROOF_PDF` at the
original `controlledPdf()` bytes. `PROOF_URL` selects the local development
viewer (default port 4390); `PROOF_OUT` selects an untracked output directory.
The harness uses real UI actions for calibration, preview, creation, history and
export, canonical store/camera helpers for framing, and actual pointer input for
selection. It closes its browser in `finally`. No viewer geometry is fabricated.

The manual browser harness is registered as a Knip entry point. Knip remains
non-green on repository-wide unused/unresolved reports; none of this change's
production modules or the renamed helpers is listed. No unrelated cleanup sweep
is included.
