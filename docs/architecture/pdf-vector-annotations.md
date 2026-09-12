# PDF vectors in the drawing canvas and 3D

Implementation contract for [F8 / #4406](https://github.com/LTplus-AG/ifc-lite/issues/4406).
The [pinned PDF investigation](evidence/pdf-vectors/README.md) establishes inputs
and controls. Conversion is enabled for the qualified subset described below,
gated by a fidelity report. This document records the implementation boundaries
so the PDF adapter does not become a second drawing system or IFC writer.

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

The prepared page carries `paths` — only paths whose complete graphics state
the planner understands — and a `fidelity` report (next section). It contains
**no IFC plan**, flattened geometry, contour classification or paint-order
composition. Forms, transparency groups, annotation appearances, clipping,
ExtGState dictionaries, optional content, images, shadings/patterns, painted
text, dashes, curved strokes and device-dependent painted
hairlines are interpreted in order and recorded as omissions with their
original operator ordinal, kind, page-space extent and visibility; they never
become paths drawn without their clip or effect. Unused font/text-position
setup is nonpainting and produces no omission. Unknown operations are never
ignored.

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

Canonical Rust then flattens curves to the declared model-metre tolerance,
outlines strokes in construction space **before** nonuniform transforms,
classifies nonzero/even-odd fills and resolves ordered overlap (the sections
below). Stroke outlining preserves visual vector geometry, not editable
centreline or text semantics.

The prepared page also returns `pageClipPdf`. The implicit page clip is resolved
by the fill planner even when no explicit `clip` operator appears; paths crossing
the effective CropBox are not published merely because their state was understood.

## Fidelity report and partial acceptance

`prepare_pdf_vector_page` returns a `FidelityReport` (`ifclite-pdf-fidelity-v1`)
beside the convertible paths. Its `summary` lists every omission kind with a
total count, a visible count and the union extent of the visible entries in
unrotated PDF user space (CropBox coordinates); `omissions` lists up to 4,096
individual entries with operator ordinal, extent and visibility, and
`omissionsTruncated` says when that detailed list stopped while the counts
stayed complete. Kinds are `text`, `image`, `clip`, `transparency`, `pattern`
(fill/stroke pattern colours and shadings), `dash`, `curvedStroke`, `hairline`, `hidden` (optional content the document
configuration turns off), `annotation` (annotation appearance streams) and
`unsupported:<operator>`.

Visibility follows what the pinned canvas would paint: an entry is visible when
its extent intersects the effective page clip, it is not inside hidden optional
content and, for text, its render mode paints. Text extents are em-box estimates
from font advances, images map the unit square through each placement, shadings
take the page clip. A rectangular clip that still contains the whole page clip
removes nothing and is not an omission; the containment test allows the
rectangle to fall short of the page by the declared tolerance (metres mapped
back through the calibration's largest scale), because exporters routinely
clip to a rectangle a few thousandths of a point inside the CropBox and that
strip is below the tolerance the user declared. Any other clip, a painted text clip,
transparency (non-unit alpha, blend modes, soft masks, composited groups) and
unknown operators taint the rest of their save scope, and a pattern colour
taints until a solid colour replaces it, so every later paint in that scope is
reported rather than drawn without its clip or effect. A combined fill/stroke
keeps its convertible half and reports the other.

`exact` is true when no omission is visible. `rasterOnly` is true when nothing
converts, no visible vector content is omitted and at least one image is
visible: a scanned sheet stays a raster reference and the vector action is
disabled rather than presented as editable vectors. The report's `sha256` binds
the request digest to the verdict (exact, raster-only, convertible paths,
omitted paints and the summary).

`planPdfFillAnnotation` recomputes the report. An exact page plans directly. A
page with visible omissions refuses unless `acceptedFidelitySha256` quotes the
digest of the report the host displayed, and refuses when the quoted digest does
not match; a raster-only page refuses regardless. Geometric qualification
failures (unqualified curves, stroke topology, budgets) still refuse the whole
page after acceptance — acceptance covers the listed omissions, not geometry.

Every created annotation carries its verdict: `IfcAnnotation.Description`
states `exact conversion` or `partial conversion; omitted N <kind>…` with the
kinds spelled out for readers (`1 text run`, `556 hairline strokes`,
`2 entries under unsupported operator setGState:TR`); the canonical kind
tokens stay in the property set's `Omissions` JSON. The
`IfcLite_PdfVectorConversion` property set (attached through
`IfcRelDefinesByProperties`) records the source PDF digest, page, CropBox,
UserUnit, rotation, decoder version, calibration key, PDF-to-model affine,
declared tolerance in metres, composition grid, request and fidelity digests,
`ExactConversion`, `AcceptedPartialConversion`, converted paths, fill regions,
omitted paints (visible painted parts only, so an exact page records zero) and
the omission summary as JSON text. It uses ordinary IFC
property types so it survives host export and reopens in any IFC reader; it
does not make omitted content recoverable. Evidence for the controlled
categories and the real drawings, the MuPDF raster comparison confining every
difference between page and output (native 3D meshes and reopened 2D fill
areas) to the reported extents, and the browser journey through the report
step are in [evidence/pdf-fidelity-report](evidence/pdf-fidelity-report/README.md).

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
geometry path. Its initial straight-fill slice accepts complete opaque RGB pages,
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
The later qualified curve and solid-stroke slices below extend this same path;
the shared workspace offers an explicit PDF vectors representation. Outlined strokes represent visual filled geometry,
not preserved editable centreline or font semantics.

## Qualified curved fills

The same native annotation plan now accepts bounded quadratic/cubic pieces after
model-plane de Casteljau subdivision. Control-hull and boundary-separation proofs
qualify a conservative subset without using sampled chords as evidence of
original curve topology. A shared endpoint is allowed only with an explicit
separating-line proof; a two-piece lens/closing chord has a separate sidedness
proof. Exact monotone collinear controls may become their identical line.

The [curved PDF evidence](evidence/pdf-curved-fill-annotations/README.md) includes
an elliptical hole and a sheared ellipse, independent source-curve comparison,
reported raster-support differences and exported IFC checks. Unsupported stroke,
text, image, clipping and transparency semantics still refuse the whole page.
This is visual vector geometry; source Bezier editing semantics are not retained.

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
limits before requesting publication. Image remains the default representation. The PDF vectors choice runs this qualification before enabling creation.

## Qualified solid straight strokes

The same `planPdfFillAnnotation` route also accepts positive-width solid straight
strokes with butt/square/round caps, bevel/miter/round joins and PDF miter-limit fallback.
Offset contours are constructed in path coordinates before the entire affine
transform, preserving nonuniform scale and shear of stroke width. Combined
fill/stroke operators expand to fill then stroke, retain their source operator
ordinal and distinct colours, and share the existing clipping, paint-order,
work, topology and canonical IFC creation bounds.

Reversals, degenerate segments, offset segment collapse and offset contour
self-contact/crossings refuse the whole page. This first sufficient qualifier
does not repair wide/self-overlapping stroke arrangements. Round arcs are
subdivided with a post-affine metric error bound. Hairlines, dash patterns and
curved strokes remain unsupported. Outlining
produces visual filled vector geometry, not editable centreline/text semantics.
Original-PDF raster and independent IFC evidence lives in
[evidence/pdf-straight-stroke-annotations](evidence/pdf-straight-stroke-annotations/README.md).

## One lattice for the complete page

Sequential classification, CropBox clipping and opaque paint composition use
one canonical `FixedGridComposition`. Original path groups and CropBox are
qualified and quantized together once; intermediate results retain integer
coordinates until final model-coordinate export. This prevents a floating
roundtrip from inventing a tiny gap at an originally identical page boundary.
The planner precharges initial pairwise qualification as well as every overlay;
original page contours are capped at 1,024 vertices, with unchanged shared work
and cumulative output bounds. See [registered original-page evidence](evidence/pdf-composition-lattice/README.md).

## Registered PDF annotation workflow

In Appearance, register a whole PDF page using Place reference and its metric
calibration, then expand Save into model for that drawing. Choose the editable
IFC model, spatial container and Name. Image preserves the page raster; PDF
vectors prepares the supported opaque fill and straight-stroke subset as coloured
`IfcAnnotation` geometry. Original document identity is required: a legacy
image-only registration cannot acquire vector provenance from a mutable source
slot. Re-uploading the original document can restore its retained provider.

Prepare vector preview reads the registration's original page and calibration,
not the currently selected page in the source catalog. The isolated, face-on
preview displays every canonical native mesh part and its colour. Orbit and zoom
inspect geometry before Create annotation publishes it through the shared
transaction. No IFC rows or main-scene meshes exist during preview. Creation
selects the new owner and records one ordinary Undo/Redo entry; the registered
drawing remains independently available.

Changing the target, container, Name or metric tolerance discards the prepared
result. Cancellation, closing the controls, source replacement and stale model
state release the pending worker, preview and retained PDF lease. The operation
checks the exact effective IFC SHA-256 and original PDF/page/calibration identities
before publication. The existing coordinate adapter preserves saved placement,
page rotation, UserUnit and native CropBox while converting the raster vertical
axis once; it does not solve another calibration.

Prepare vector preview first obtains the canonical fidelity report and shows it.
An exact page continues straight to the native preview. A partial page stops at
the report — each visible omission kind with its count and page region — and the
action becomes Prepare partial conversion, enabled only after the explicit
"Create a partial conversion" acknowledgement; the accepted report digest travels
with the plan and its omissions are recorded in the created annotation's property
set. A raster-only page disables the action with a raster-reference message and
is never presented as editable vectors. Changing the drawing or tolerance discards
the report; changing the target, container or Name discards only the prepared
result.

User-cropped raster registrations are explicitly refused for vectors because their
extra crop has not been qualified by the native geometry planner. Use Image for
those pages. Native refusals do not create partial annotations; a partial
annotation exists only after the user accepted its listed omissions. Tolerance
bounds geometric approximation in model metres after calibration; it is not a
claim that arbitrary PDF typography or graphics have been preserved.
