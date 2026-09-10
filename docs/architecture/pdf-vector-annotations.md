# PDF vectors in the drawing canvas and 3D

Implementation contract for [F8 / #4406](https://github.com/LTplus-AG/ifc-lite/issues/4406).
The [pinned PDF investigation](evidence/pdf-vectors/README.md) establishes inputs
and controls. Conversion is not yet enabled. This document records the next
implementation boundaries so the PDF adapter does not become a second drawing
system or IFC writer.

## Representation and existing annotation work

A flat drawing can occupy a plane in a 3D model. That does not make its strokes
solids. IFC supports annotation curves, text and fill areas through
[`IfcAnnotation`](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcproductextension/lexical/ifcannotation.htm).
[`Annotation2D`](https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcShapeRepresentation.htm)
is a representation type, not a requirement to show the object only in the
2D canvas. Placement, geometric context and the active drawing view remain
separate concerns.

The existing drawing-markup writer in `packages/create/src/in-store/` already
emits `IfcPolyline`, `IfcAnnotationFillArea` and `IfcTextLiteralWithExtent`.
Reuse its entity and drawing-context conventions. Its comments currently
identify it as write-side support; its presence does not prove that imported
annotations render in 3D.

The Rust router has no standalone registry processor for those three primitives.
Product-scoped polygonal fill support is described in [the fill controls](evidence/annotation-fills/README.md);
curves and text remain separate future geometry slices.
It also deliberately omits type-level annotation/footprint geometry from the
building body's 3D mesh. Do not globally enable every `Curve2D` or `FootPrint`
representation to make PDF output appear: that would also draw representations
belonging to unrelated building types.

The next geometry slice must distinguish an `IfcAnnotation` product's selected
representation from a building product's auxiliary representations, and converge
in `produce_element_meshes` for native and WASM consumers. A browser-only mesh
overlay cannot establish ordinary IFC import or portable export support.

## Page adapter contract

PDF.js owns decoding; canonical Rust owns geometry and IFC planning. Between them
use a bounded page display list containing page-local paths, graphics-state
snapshots, paint order and a fidelity report. It must retain the PDF digest,
decoder version, page index, CropBox, UserUnit, rotation and calibration recipe.

Do not reconstruct page semantics from the census counters. The real Featherston
page contains forms, clipping, optional content and graphics-state operations.
Its visible curved symbols are decoded polylines; the controlled page supplies
actual cubic commands. Both inputs are necessary to exercise the adapter.

Interpret save/restore, concatenated transforms and path construction in order.
Transforming only path vertices is insufficient for nonuniformly scaled strokes:
width, dash distances, caps and joins must follow the same PDF painting semantics.
PDF hairlines are device-dependent; a physical IFC line width requires an
explicit approximation policy, not an invented exact conversion.

Flattening curves requires a declared tolerance in calibrated model metres and
a subdivision/work budget. Refuse before publishing any entities if the budget
is exhausted. A tolerance in display pixels would make exported geometry depend
on the user's current zoom.

Fill conversion must classify contours under the actual nonzero/even-odd rule.
An [`IfcAnnotationFillArea`](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcAnnotationFillArea.htm)
requires valid planar boundaries and holes. Do not pass arbitrary self-crossing
PDF paths to the existing polygon-with-holes triangulator and assume equivalent
fill. Fill styles must resolve through canonical native presentation handling,
including `IfcFillAreaStyle`; a surface-style-only lookup is insufficient.

Paint order also needs an explicit implementation. Overlapping opaque fills
cannot be emitted as coplanar triangles and left to depth testing, nor may later
paint be silently moved away from the calibrated plane. Resolve visible regions
or use an established annotation rendering contract that preserves the order;
verify the exported result independently before choosing between these paths.

## One interaction flow

Within the selected PDF source, offer **Create annotation** alongside the existing
page appearance and reference actions when a qualified adapter is available.
Reuse page selection, crop, scale calibration and plane placement. Switching
between 2D and 3D changes the view of the same prepared result.

The first preview compares the rendered source page with the proposed geometry.
The report separates supported content, declared approximations and omissions.
Keep source raster visibility independently controllable so a user can inspect
line alignment without losing the page context. A raster-only scan offers the
existing reference action rather than an empty vector result.

Unsupported visible text/fonts, images, clipping, transparency, patterns or
optional-content semantics prevent exact conversion. A partial result requires
an explicit acceptance naming what is omitted; disabling an unsupported
operator and retaining an unqualified Create button is not partial acceptance.
Keep the original PDF/reference available after creation.

Selection resolves the created annotation owner through the existing federation
and mutation-view identity path. Apply publishes IFC entities, geometry,
hierarchy and source ownership in one transaction. Discard releases preparation;
Undo/Redo restore the whole operation. No duplicate raster and vector objects
should be created implicitly.

## Dependency-ordered acceptance

1. Prove ordinary native/WASM processing of a bounded annotation subset, with
   valid horizontal and vertical placement, model units, fill holes and styles.
   Include a building type footprint that must remain absent from body geometry.
2. Decode controlled page paths and graphics states into the bounded display
   list. Test CropBox/UserUnit/rotation, nonuniform transforms, curve tolerance,
   paint order and explicit refusals through real PDF input.
3. Produce a canonical IFC plan and compare exported geometry and styles in an
   independent reader. Preserve source ownership and report unsupported parts;
   neither an operator count nor a successful IFC parse proves fidelity.
4. Integrate the shared preview and transaction. Exercise selection in 2D/3D,
   cancellation/staleness, Apply/Undo/Redo, fresh import, federation and room
   export/reopen on the controlled PDF and real vector drawing.

Each step can land as a reviewable stack against #4406. The issue stays open
until the complete supported journey has visual and independent-reader evidence.

## Bounded graphics-state preparation

`ifc_lite_processing::pdf_vector::prepare_pdf_vector_page` (WASM
`IfcAPI.preparePdfVectorPage`) consumes the immutable decoded page DTO produced by
an additional `vectors` job in the existing PDF engine/worker. The decoder is
pinned to PDF.js 6.3.289. Native preparation validates save/restore, concatenated
transforms, solid RGB paints, line width/caps/joins/miter/dash state, packed
DrawOPS command arities and original operator order. It retains cubic/quadratic
commands unchanged and snapshots complete affine state for each painted path.

`stateQualified` means only that this graphics-state subset was understood. The
report contains **no IFC plan**, flattened geometry, contour classification,
paint-order composition or exact-conversion permission. `paths` in an
unqualified report are diagnostic input only, not a supported partial export.
Unsupported forms, groups, clipping, graphics-state dictionaries, optional
content, images, patterns and painted text retain original operator indices as
blocking diagnostics. Device-dependent painted hairlines also block qualification.
Unused font/text-position setup is nonpainting and does not alone block a page.
Unknown operations are never ignored.

The request binds the exact retained PDF SHA-256, pinned decoder, one-based page,
effective native CropBox, UserUnit, intrinsic rotation, host calibration identity,
explicit native-PDF-to-model-plane affine and declared metric flattening tolerance.
The host supplies that affine from the existing page recipe and measured model
calibration; native preparation does not infer model scale from physical paper
size. A request digest binds all typed operations, metadata and policy values.
Native code receives decoded data, so the host must verify this data against the
retained PDF; a caller-provided source digest alone is not authentication.

The WASM boundary limits JSON to 32 MiB; preparation limits operations to 100,000,
path numbers to two million, painted paths to 20,000, save depth to 64 and dash
arrays to 128 entries. Malformed structure, unbalanced state and exhausted budgets
refuse atomically. The existing PDF worker owns its timeout/cancellation and
releases the document/page. PDF.js allocates its operator list before the adapter
can count it, so these post-decode limits are not a claim about a strict decoder
native-allocation ceiling. Unsupported or over-budget input creates no entities.

Next, canonical Rust must flatten curves to the declared model-metre tolerance,
outline strokes in construction space **before** nonuniform transforms, classify
nonzero/even-odd fills, and resolve ordered overlap. Stroke outlining preserves
visual vector geometry, not editable centreline or text semantics. Only then can
the shared annotation creation transaction expose 2D/3D Compare and Apply.

The report also fixes `geometryReady=false`, returns `pageClipPdf` and enumerates
pending geometry stages. The implicit page clip must be resolved even when no
explicit `clip` operator appears; paths crossing the effective CropBox cannot be
published merely because their state was understood.

This construction-space contract applies to well-formed PDF path objects. In
[ISO 32000-1 §8.2, Figure 9 and its following note](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf),
graphics-state changes are outside path-object construction. A malformed control
placing `cm` or `q/Q` between path construction and painting is not evidence of a
conforming decoder defect: pinned PDF.js fuses its coordinates with paint-time
state, and independent Poppler rendered the tested reordered pair identically.
The adapter does not independently certify raw content-stream conformance after
PDF.js decoding. It must not claim arbitrary malformed-PDF extraction fidelity.

## Complete straight-edge fill page planning

`planPdfFillAnnotation` advances state-qualified pages through a bounded native
geometry path. It accepts only complete opaque RGB straight-edge fill pages,
resolves fill rule and the implicit CropBox, and subtracts later paint before
creating colored annotation fill areas. It reuses canonical authored source,
placement, allocation and mesh production; no separate STEP writer is involved.

A fixed-grid overlay guard refuses distinct endpoint collapse, changed edge
orientation classifications and uncertain near contacts/intersections. Its first
bounded scope also refuses edges with multiple proper crossings. The guard is
conservative: valid complex or tiny features may be refused. Final canonical mesh
coordinates must agree with the quantized contours within the requested metric
tolerance; this transport check is distinct from original-path fidelity.

The [two actual decoded PDF controls](evidence/pdf-fill-annotations/README.md)
exercise winding, holes, clipping and paint order with independent source raster
and exported IFC checks. They do not establish universal conversion fidelity.
Shared UI transaction integration and curved/stroked page conversion remain
separate required work. Outlined strokes will represent visual filled geometry,
not preserved editable centreline or font semantics.

## Shared authored-owner publication

Native PDF fill plans use the same authored-product transaction as image references
and captured meshes. `commitAuthoredProduct` accepts all canonical parts for one
IFC owner and an explicit retained-image list (empty for solid fills). It stages
all colour buckets and textures before committing IFC rows, publishes every part
together, and records one Undo/Redo entry. Replay checks every part so a later edit
to one colour cannot partially rewind the annotation. The renderer's
`prepareAuthoredOwner` rejects changed scene or placement state before publication.

This transaction does not qualify PDF content or establish source identity. Its
caller must retain the original PDF, page and calibration, verify the native
source-IFC digest against the exact frozen bytes, and enforce the PDF transport
limits before requesting publication. The image-based annotation workflow remains
the active UI until the representation choice and its native qualification review
are integrated.
