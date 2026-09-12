# Appearance, drawings and capture roadmap

This is the consolidated delivery plan for images, PDF pages, registered
references, captured surfaces and future Scan-to-BIM options. Planning IDs
F0–F16 describe dependencies; they are not feature flags or promises that every
adapter is available. Status below was verified on 2026-09-10. Active issues own
the remaining acceptance work.

## One workspace

**Author → Appearance** is the shared entry point. A source offers the actions
that its working adapters support: apply appearance to IFC, place a registered
reference, or create an IFC object from a selected captured region. Image/PDF
editing and scan work share source ownership, coordinate registration, target
selection, history and portable export. They do not need separate applications.

Appearance assignment starts with the target scope: selection, exact IFC class,
exact type or model. Creation starts with a source region and a destination model
and spatial container. Names are display labels; entity and source identities
must remain distinct even when names or express IDs coincide across models.

A PDF page can supply raster appearance or a calibrated drawing plane. Vector
conversion is a separate operation, with a conversion report. Drawing entities
must integrate with the existing 2D canvas and also be reviewable and selectable
in their 3D plane; a raster projection is not equivalent to vector annotation.

## Delivery and acceptance

| Slice | Capability and dependency | Current state / exit evidence |
| --- | --- | --- |
| F0 | Texture preservation and picking through load, split, cache and share | Foundational fixes merged. Later slices must repeat ordinary import, picking and fresh-room acceptance for their own output. |
| F1 / F0 | Image library, model/selection/class/type scope, UV/planar/box controls, compare/discard/apply/Undo and IFCZIP | Integrated image workflow merged. [Workspace evidence](appearance-workspace.md) covers real Convento edits and portable output. Trusted-input responsiveness improvement [#4402](https://github.com/LTplus-AG/ifc-lite/pull/4402) is merged; the final synchronous transaction fence remains documented. |
| F2 / F1 | PDF page/crop, planar projection and metric calibration | Integrated raster PDF workflow merged. [Real drawing evidence](evidence/pdf-appearance/README.md) includes a printed known span, export/reopen and room viewing. This does not establish vector conversion fidelity. |
| F3 / F1 | Registered drawing sources, horizontal/vertical placement, independent selection, hide/lock, restoration and explicit textured IfcAnnotation creation | Native planning, reference library, editing and creation are merged. [Creation evidence](evidence/reference-annotation/README.md) and [editing evidence](evidence/reference-edit/README.md) cover real browser journeys. [Rotated PDF, 2D canvas and room evidence](evidence/reference-pdf/README.md) completes the scoped acceptance for [#4308](https://github.com/LTplus-AG/ifc-lite/issues/4308). |
| F4 / F3 | Registered textured-mesh and RGB-point appearance transfer with coverage and bounded atlas baking | Delivered [#4381](https://github.com/LTplus-AG/ifc-lite/issues/4381). The canonical rigid correspondence solver is merged in [#4405](https://github.com/LTplus-AG/ifc-lite/pull/4405); the bounded native textured-mesh transfer planner in [#4416](https://github.com/LTplus-AG/ifc-lite/pull/4416); emitted-pixel applicability in [#4423](https://github.com/LTplus-AG/ifc-lite/pull/4423); the behind-surface limit and [controlled thin-wall, occluder and gap acceptance](evidence/mesh-transfer-surfaces/README.md) in [#4539](https://github.com/LTplus-AG/ifc-lite/pull/4539). The transfer source is now a tagged union: a textured GLB surface, or an **RGB point cloud** (`planPointTransfer`) whose samples are local plane fits with an explicit, recorded orientation source (`source-normals`, `viewpoints` or `target-referenced`) and target-geometry side rules — self-occlusion for captures outside the solid, nearest-face attribution (behind bound capped at the midplane) and front-over-inside preference for unoriented captures inside it — that keep opposite thin-wall faces apart up to the midplane under every orientation source; the viewer aligns and transfers any completely streamed point cloud (LAS/LAZ/E57/PLY/PCD/PTS/XYZ) from its retained sample, with point landmarks picked on a local preview. The **real-pair gate is met**: [CRAS registration and transfer](evidence/scan-registration-cras/README.md) registers the complete CC BY 4.0 archive's scan to the published model through 16 three-plane landmarks (8 fit, 8 held-out, frozen before solving; held-out RMS 4.5 cm, max 6.5 cm, tolerance 7 cm by a pre-stated rule) and transfers point colour onto two walls with measured observed/refused/unknown coverage reported per face (the measured as-built offsets — a corridor face 6 cm in front of its modelled face, a room wall shifted ~5 cm so its far side's capture lies inside the modelled solid — are exactly the regime the side rules are tested in), a budget refusal, independent IfcOpenShell reopen, IFCZIP packaging and a fresh room join. Same-source browser controls ([workspace](evidence/scan-transfer-workspace/README.md), [room portability](evidence/scan-transfer-room/README.md), [full selected target](evidence/mesh-transfer-full-target/README.md)) cover Preview, Compare, Apply, Undo/Redo, export, import and sharing. Remaining limits are stated in [what counts as validated](scan-alignment-workbench.md#what-counts-as-validated): the held-out residuals are as-built deviations of a model, not survey control; voided extrusion targets belong to F6 (#4404); complete source-supplied PLY `nx`/`ny`/`nz` normals now survive canonical streaming, stride, frame conversion, reservoir sampling and frozen sessions, so qualified PLY plans record `source-normals`; absent normals preserve `target-referenced`, while malformed declared normals refuse transfer. Scanner stations are not yet retained. Posed photographs, RGB-D and splats are F9. |
| F5 / F1, F3 | Existing captured region to one textured IFC object | Merged in [#4399](https://github.com/LTplus-AG/ifc-lite/pull/4399); [#4380](https://github.com/LTplus-AG/ifc-lite/issues/4380) is closed. [Native planner](evidence/captured-mesh/README.md), sampler preservation, [textured GLB ingest](evidence/captured-glb/README.md) and shared host transaction are merged. The integrated Appearance panel creates a complete surface or an explicitly selected textured triangle region. [Viewer creation/export/reopen evidence](evidence/captured-ui/README.md) and [room, IFCX and selected IFCZIP acceptance](evidence/captured-room/README.md) cover retained appearance, coordinates and picking. See the [creation contract](captured-mesh-authoring.md). |
| F6 / F1 | General evaluated surfaces, mapped-instance isolation, query scopes and face masks | Done [#4404](https://github.com/LTplus-AG/ifc-lite/issues/4404). Opt-in evaluated-occurrence planning and canonical source geometry are merged, with real repeated AC20-member tests. The integrated mapped-object preview, Compare, repeated Apply, hidden-model restoration, Undo/Redo and portable export are merged in [#4431](https://github.com/LTplus-AG/ifc-lite/pull/4431), with [real AC20 viewer evidence](evidence/evaluated-occurrences/viewer-acceptance.md). The post-opening slab journey is merged in [#4456](https://github.com/LTplus-AG/ifc-lite/pull/4456), with [native, independent-reader and viewer evidence](evidence/evaluated-openings/README.md). Saved-filter scopes use frozen effective-IFC membership and explicit recipe restoration, with [real AC20 query evidence](evidence/appearance-query-scopes/README.md). Native face masks bind to a reported surface fingerprint with explicit stale refusal and split the authored Body into textured and retained face sets, and the policy now accepts any uniquely owned tessellatable Body, with [real AC20 native and independent-reader evidence](evidence/evaluated-face-masks/README.md). The viewer's face-selection editor, the partitioned textured + retained preview with Compare/Discard/Apply/Undo/Redo, session mask state with planner-reported stale diagnostics, portable export and reopening, and the [real AC20 browser and independent-reader acceptance](evidence/evaluated-occurrences/face-mask-ui/README.md) (including a masked opening-bearing slab) complete the slice. Unsupported conversions stay explicit diagnostics. |
| F7 / F1, F6 | Coordinated multi-model Apply, assignment ordering/exceptions and persistence | Implemented under [#4420](https://github.com/LTplus-AG/ifc-lite/issues/4420): frozen explicit scope/source identities, ordered exceptions, atomic publication and grouped Undo/Redo, and reviewed recipe restore in the existing workspace. [Real two-copy AC20 evidence](evidence/coordinated-appearance/README.md) covers mapped targets, distinct images, Compare/Apply/Undo/Redo, separate IFCZIP exports, normal picking and per-model Share/rejoin/room export. Rooms now carry an explicit federation scope — one slot per shared model, two copies of one file included ([#4444](https://github.com/LTplus-AG/ifc-lite/issues/4444), [browser evidence](evidence/federation-scope/README.md)); initial seed readiness remains the separate [#4446](https://github.com/LTplus-AG/ifc-lite/issues/4446) follow-up. |
| F8 / F3 | Supported PDF vectors to IfcAnnotation | Active [#4406](https://github.com/LTplus-AG/ifc-lite/issues/4406). [Real vector/control investigation](evidence/pdf-vectors/README.md) pins the decoder. Merged [#4432](https://github.com/LTplus-AG/ifc-lite/pull/4432) adds native/WASM standalone polygonal fills with holes, placements and solid styles, backed by [independent-reader evidence](evidence/annotation-fills/README.md). Merged ordered graphics-state preparation qualifies decoded state. Complete opaque fill-page planning includes qualified quadratic/cubic fills and solid straight strokes (butt/square caps, bevel/miter joins), with original PDF raster and independent IFC-reader evidence. The registered-drawing workspace offers an explicit PDF vectors choice with native preview, creation and shared Undo/Redo. The canonical fidelity report classifies text, images, clipping, transparency, patterns, dashes, round caps/joins, curved strokes, hairlines, hidden optional content, annotation appearances and unknown operators with counts, page extents and visibility ([evidence](evidence/pdf-fidelity-report/README.md): an independent MuPDF raster differs from the native 3D and reopened 2D output only inside the reported extents, and the real-browser journey covers report, acknowledgement, create, Undo/Redo, export, reopen and independent-reader provenance); exact pages convert directly, partial pages only after explicit acceptance of the listed omissions (recorded in the annotation's `IfcLite_PdfVectorConversion` property set with source, calibration and metric tolerance), and raster-only pages are refused as raster references. Round caps and joins are converted as metric-tolerance-bounded contours, including under nonuniform scale and shear; requests below model-coordinate numerical precision refuse explicitly. Converting the remaining omitted categories remains outstanding; there is no arbitrary-page fidelity claim. The [annotation processing contract](pdf-vector-annotations.md) defines the native/2D/3D integration boundaries. Compare curves, fills, text, fonts and line styles against the page raster in 2D and 3D and in an independent IFC reader. Unsupported operators block exact conversion or require explicit acceptance of partial output. |
| F9 / F4 | Posed-photo/RGB-D sampling and rendered-view splat adapters | Future adapter evaluation. Require camera/scale evidence, held-out views, coverage, seam and bleed measurements. Nearest-Gaussian color is not a validated substitute for view-based appearance. |
| F10 / F5, F9 as needed | Reconstruction and optionally fitted walls/slabs | Future evaluation. Compare the same real region across candidates; measure surface deviation, thin features and correction effort. Users review thickness, openings and class before atomic creation. |
| F11 / F1 | Optional tiling and repetition improvements | Future option. Preserve oriented grain and brick courses, compare original/processed appearance, and bake portable output matching preview. Generated detail must remain distinguishable from scan observations. |

F5 does not depend on point-cloud or splat reconstruction: it starts from an
existing textured mesh. F4 measures appearance transfer to different geometry;
it is a separate capability, not something implied by copying a captured mesh.
Finish each slice's real user journey before calling it complete.

## Source capability boundaries

| Source | Supported or planned action | Required distinction |
| --- | --- | --- |
| PNG/JPEG | Image appearance and calibrated reference | Original bytes and source identity survive preview, history and export. |
| PDF page, including scanned pages | Raster appearance/reference; later supported vector conversion | Page, crop, rotation and metric calibration belong to the source recipe. OCR/vectorization is a separate reviewed operation. |
| Textured mesh | Existing-region creation; later registered transfer | Current GLB support is embedded base-color PNG/JPEG with supported UV/material semantics. Unsupported maps are diagnosed; full PBR is not silently claimed. |
| RGB point cloud | Registered, surface-aware sampling; qualified PLY normals orient its local support planes | No RGB means no measured color. PLY normal triples must be complete, finite and nonzero. Object creation requires a separately evaluated reconstruction step. |
| Posed photos/RGB-D | Planned visibility-aware view sampling | Intrinsics, poses, scale and coverage are inputs, not inferred guarantees. |
| Unposed photos | Future reconstruction adapter | Show missing reconstruction/calibration requirements before offering transfer. |
| Gaussian splat | Future registered reference/view bake and reconstruction adapters | Evaluate rendered color/depth/alpha views and geometry separately. A splat is not already an IFC surface. |

The table describes the roadmap, not a file-extension support promise. Controls
must follow actual canonical importer and adapter capabilities. An unavailable
operation must not look like a working Apply button.

## Shared engineering and UX contract

- Every loaded source model enters `useIfcLoader.loadFile`; format adapters must
  not create a second viewer ingestion pipeline.
- IFC entities, geometry and texture associations are planned in canonical Rust.
  Host code publishes one guarded transaction for entities, geometry, hierarchy,
  original-image ownership and history. It does not write a second STEP dialect.
- Source coordinates, workspace registration and destination placement are
  separate. UV seams and sampling conventions cross each boundary exactly once.
  Preview, selection and export must agree in single-model and federated scenes.
- Adjustments prepare a cancellable preview. Source, region, model or placement
  changes invalidate stale work before publication. Discard restores the saved
  state; Undo removes created objects and all corresponding selection state.
- Keep original images with stable identities and explicit owners. Model removal,
  cancelled decoders, replaced previews and discarded history release their own
  resources. Export packages retained originals; it does not recover source
  pixels from GPU textures.
- IFCZIP preserves the accepted visual IFC result, not all scan inputs or
  editable source recipes. A future project bundle must preserve those separately
  rather than presenting ordinary IFC export as a complete project backup.
- The initial capture class is IfcBuildingElementProxy. Capturing observed
  triangles does not establish wall semantics, thickness or watertightness.
- Replacing parametric geometry with a tessellated appearance representation is
  an explicit policy decision, preserving identity/properties and avoiding
  duplicate visible geometry. Occurrence overrides must not restyle all mapped
  instances accidentally.
- Expensive preparation needs bounded memory, progress and cancellation. Optional
  service/inference work states where processing occurs and must not burden the
  normal viewer load path.

## Future semantic Scan-to-BIM options

These are experiment slices, not enabled inference features. Recognition returns
reviewable proposals; it never directly changes an IFC class or relationship.

| Option | Reviewable capability | Evidence gate |
| --- | --- | --- |
| F12 / F3, F4 | Associate scan observations and deviations with existing IFC | Real paired data and controlled changes; ambiguous or occluded observations stay unknown. Preserve GlobalIds and avoid silent deletion. |
| F13 / F3, F5 | Suggested capture classes/instances with split/merge/relabel review | Building-disjoint semantic/instance evaluation, retained source indices and measured correction effort. Unknown classes do not create entities automatically. |
| F14 / F10, F13 | Reviewed wall/slab/column/opening candidates with levels, axes and thickness | Evaluate fitting with oracle masks and predicted masks separately; measure held-out residuals, host/opening correctness, non-Manhattan cases and editability. |
| F15 / F12, F14 | Bounded as-built updates and new-object proposals | Before/after geometry and relationship diff, identity preservation, split/merge lineage, unchanged unrelated objects and texture rebake invalidation. |
| F16 / F9, F13 | Multi-view/open-vocabulary/splat semantic and contextual proposals | Independent-view consistency, rare/unknown classes and geometric evidence for host/adjacency suggestions. Text similarity is not structural evidence. |

Proposal records retain the model/checkpoint revision, source region membership,
class alternatives and geometric constraints. Measured, inferred and
user-confirmed evidence remain distinguishable. Accepted results use the same
IFC transaction and Undo/Redo path as manual creation.

Start with evidence association and region review, then evaluate bounded object
fitting. Producing an entire new building requires an additional completeness
and topology gate; successful creation of one surface does not satisfy it.
