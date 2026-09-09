# Appearance, drawings and capture roadmap

This is the consolidated delivery plan for images, PDF pages, registered
references, captured surfaces and future Scan-to-BIM options. Planning IDs
F0–F16 describe dependencies; they are not feature flags or promises that every
adapter is available. Status below was verified on 2026-09-09. Active issues own
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
| F4 / F3 | Registered textured-mesh and RGB-point appearance transfer with coverage and bounded atlas baking | Active [#4381](https://github.com/LTplus-AG/ifc-lite/issues/4381). The canonical rigid correspondence solver is merged in [#4405](https://github.com/LTplus-AG/ifc-lite/pull/4405). The transfer kernel remains active. The [bounded CRAS evidence](evidence/scan-transfer/README.md) pins a real scan/model candidate; it still needs independently checked registration and held-out correspondences before accuracy is claimed. Correct scan-to-scan registration alone does not establish scan-to-IFC alignment. The [manual GLB alignment workbench](scan-alignment-workbench.md) now provides picked fit/check pairs, residual review and a dedicated aligned preview; its [same-source browser control](evidence/scan-alignment-workbench/README.md) validates interaction and held-out isolation, not real-world scan accuracy. Acceptance also covers opposite thin-wall surfaces, unknown regions, preview/apply/Undo and export/reopen/share. |
| F5 / F1, F3 | Existing captured region to one textured IFC object | Merged in [#4399](https://github.com/LTplus-AG/ifc-lite/pull/4399); [#4380](https://github.com/LTplus-AG/ifc-lite/issues/4380) is closed. [Native planner](evidence/captured-mesh/README.md), sampler preservation, [textured GLB ingest](evidence/captured-glb/README.md) and shared host transaction are merged. The integrated Appearance panel creates a complete surface or an explicitly selected textured triangle region. [Viewer creation/export/reopen evidence](evidence/captured-ui/README.md) and [room, IFCX and selected IFCZIP acceptance](evidence/captured-room/README.md) cover retained appearance, coordinates and picking. See the [creation contract](captured-mesh-authoring.md). |
| F6 / F1 | General evaluated surfaces, mapped-instance isolation, query scopes and face masks | Active [#4404](https://github.com/LTplus-AG/ifc-lite/issues/4404). Opt-in evaluated-occurrence policy is being validated on real repeated AC20 members. Post-opening texture boundaries and stable masks remain acceptance work; unsupported conversions stay disabled. |
| F7 / F1, F6 | Coordinated multi-model Apply, assignment ordering/exceptions and persistence | Later slice. One action must publish/Undo all targets or none, retain exact source ownership, and report membership changes after reload. This is distinct from viewing completed models in a room. |
| F8 / F3 | Supported PDF vectors to IfcAnnotation | Active [#4406](https://github.com/LTplus-AG/ifc-lite/issues/4406). [Real vector/control investigation](evidence/pdf-vectors/README.md) pins the decoder and exposes the missing standalone 3D annotation processor; no conversion action is enabled yet. The [annotation processing contract](pdf-vector-annotations.md) defines the native/2D/3D integration boundaries. Compare curves, fills, text, fonts and line styles against the page raster in 2D and 3D and in an independent IFC reader. Unsupported operators block exact conversion or require explicit acceptance of partial output. |
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
| RGB point cloud | Planned surface-aware sampling after registration | No RGB means no measured color. Object creation requires a separately evaluated reconstruction step. |
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
