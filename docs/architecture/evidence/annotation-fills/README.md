# Native annotation fill controls (#4406)

The bounded first geometry slice processes direct `IfcAnnotationFillArea` items
on actual `IfcAnnotation` products. Accepted non-body representation types are
`Annotation2D` and `Surface2D`. Existing body representations continue through
the same router. No primitive is registered globally, so a building type's
auxiliary footprint map remains absent from its body geometry.

The initial boundary subset is explicitly closed `IfcPolyline` rings of finite
2D/3D Cartesian points. At most 64 rings and 2,048 input vertices per fill are
accepted. Nonplanar, touching, crossing, open, outside or nested-hole boundaries
are refused before triangulation. The existing canonical triangulator produces
the triangles; existing router scaling and placement produce world coordinates.
Indexed/curved boundaries and text are outside this slice. Mixed RGB+hatch/tile
paint, invalid/out-of-range RGB and exhausted style-reference budgets explicitly
refuse the fill with a diagnostic. Source-bound inverse lookups are shared by the
existing columnar entity index across native jobs and WASM batches.
This is ordinary IFC processing support, not PDF-to-annotation conversion.

`oracle.json` records independent IfcOpenShell 0.8.2 geometry for the explicit
millimetre control in `rust/processing/tests/annotation_fills_4406.rs`. Both
horizontal and vertical fills have an outer four-metre square and a one-metre
square hole. Schema validation reports no errors (all EXPRESS rules were not
run). The independent reader confirms area, bounds and triangle count. Its
geometry API emits a default material for this fill style; this evidence does
**not** claim cross-reader rendered-colour parity. Native tests assert colour
against the authored `IfcFillAreaStyle` → `IfcColourRgb` leaf and check its
IFC2x3 presentation-assignment wrapper separately.

The fixture is a stated geometric control, not a captured real building or an
accuracy measurement. No source IFC assets are committed. The oracle retains its
shape owner while reading geometry; releasing a temporary IfcOpenShell shape
before accessing its borrowed geometry invalidates that data.
