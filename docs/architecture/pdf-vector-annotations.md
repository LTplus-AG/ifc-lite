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

The current Rust router has no standalone processor for those three primitives.
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
