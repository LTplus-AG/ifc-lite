# Evaluated occurrence appearance policy (F6, #4404)

Image and finite-page requests keep `representationPolicy: "preserve"` by
default. `"evaluatedOccurrence"` explicitly permits the supported occurrence's
parametric Body to become evaluated tessellation. A viewer must explain this
tradeoff and show the converted products before Apply. Discard publishes nothing;
conversion and appearance belong to one mutation/history operation.

A supported occurrence is an `IfcElement` (not a `StandardCase` subclass or a
feature element) with a uniquely owned `IfcProductDefinitionShape` and one
Body shape wrapper holding one item whose RepresentationType permits
tessellation: `MappedRepresentation`, `SweptSolid`, `AdvancedSweptSolid`,
`Brep`, `AdvancedBrep`, `CSG`, `Clipping`, `SolidModel`, `SurfaceModel`,
`Tessellation` or `SectionedSpine`. Curve, point, annotation and bounding-box
Body types are refused explicitly. The wrapper may have ordinary
presentation-layer membership. A solid Body wrapper that a type's
`IfcRepresentationMap` also references is supported: the occurrence receives a
cloned wrapper with cloned plain layer assignments and its
ProductDefinitionShape list is rewired, while the original wrapper stays with
the map. A map of a `MappedRepresentation` wrapper is a chain and stays refused.
Otherwise the wrapper's Items and RepresentationType change in place. Its
identity, context, layer membership, product placement, product identity,
properties and semantic relationships stay intact. Non-Body curve and
bounding-box wrappers remain untouched. Shared mapped items, representation
maps, type products, source styles and sibling occurrences are never edited.
Retaining the occurrence wrapper avoids creating orphaned
ProductDefinitionShapes or accidentally sharing shape wrappers contrary to
IfcShapeModel.WR11. The first merged slice accepted mapped occurrences only;
the same funnel, exact corner check and refusals now cover the other types.

The canonical element-production funnel evaluates the original occurrence.
The first slice requires one unambiguous mesh and one explicit source surface
style. New tessellation coordinates use the inverse rigid product placement,
restoring mesh origin and RTC once, in source length units. Canonical reopening
must reproduce every oriented triangle corner exactly and retain the original
colour/material before the requested appearance is applied. A bounded single
IfcPresentationStyleAssignment wrapper can be flattened while keeping its
surface-style definition. The native image/page planners consume this private
typed source overlay and return one composite mutation plan, with original-item
provenance in `conversions`. Edits targeting private newly created rows are folded
into their creation records before returning the plan.

Unsupported cases remain diagnostics: aggregate-propagated voids and openings
another host consumes, StandardCase subclasses, shared Body/PDS wrappers,
shape aspects, styled presentation layers, additional renderable representations,
multiple meshes or ambiguous/inherited styles, mapped-chain and nested geometry
style overrides (even with matching colour), material-layer slicing, existing
textures, and ExistingUv conversion. No alternate visible Body is added. These
are first-slice limits, not claims that IFC cannot represent the cases.

Opening conversion is deliberately not enabled by this policy. buildingSMART
distinguishes subtractive opening Body geometry from Reference geometry accompanying
an already-cut host. Our geometry path must honor that distinction before baked
opening surfaces can be published while retaining the opening relationships.
See [IfcOpeningElement semantics](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcOpeningElement.htm).

The real IFC4 fixture is AC20-FZK-Haus from the fixture manifest, SHA-256
`ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d`.
Mapped IfcMember 35169 is one of 42 members sharing a type; its Body wrapper is
35155 and evaluated source geometry item is 35135. Native tests compare all
unselected meshes unchanged and the selected oriented world corners exactly,
exercise finite-page composition, and refuse direct/inherited openings and shared
wrappers. Independent IfcOpenShell checks compare new violations against the
source's existing validation findings; the original model is not schema-clean.

Composite output uses ascending, contiguous created IDs from `nextExpressId`.
Private conversions rejected by the final appearance pass leave no allocator
gaps. Generated references, replacement-item provenance and page image bindings
are rebound together before the plan leaves Rust; host allocation checks remain
strict.

Page material names equal to reserved wire tokens after trimming (`#123`,
`.ENUM.`, `$`, or `*`) are refused explicitly. The current authoring wire cannot
distinguish those literals from references/enumerations/null/derived values.
Other labels, including `#material` and `.surface`, remain literal strings.

For occurrence materialization, each conversion also carries the original canonical
`sourcePositions`, `sourceNormals`, `sourceOrigin`, `sourceColor`, and `rtcOffset`.
`sourceIndices` indexes these positions. Values use IFC Z-up metres: add the f64
source origin and the f64 RTC offset exactly once around local f32 vertices.
These are moved from the same bounded evaluated mesh already checked against the
replacement, not reconstructed from the renderer's rounded instance matrices.
The existing aggregate plan geometry budget also bounds these retained arrays.
The host must resolve the model index and registered placement frame explicitly;
this payload does not make renderer instance expansion canonical UV provenance.

## Face masks

A face mask restricts one occurrence's appearance to a reviewed subset of its
evaluated surface. Masks exist only under `representationPolicy:
"evaluatedOccurrence"`; a request that carries `faceMasks` with the preserve
policy is refused as a whole. Each accepted conversion reports a
`surfaceFingerprint`: the hex SHA-256 of the product GlobalId, the authored
product-local coordinates quantised to one micrometre, and the triangle
topology. Express ids are deliberately excluded, so a renumbered export keeps
a mask, while any change to the evaluated surface (an edited opening, a
different profile, another tessellator) changes the fingerprint. The authored
coordinates are rebuilt from the canonical f32 world evaluation, so the
fingerprint binds to the surface at its current placement: a placement edit
generally changes it and reports the mask stale, because f32 spacing exceeds
one micrometre a few metres from the origin; only a move that is exactly
representable in f32 (the controlled test's 10 m offset) keeps it. Stale is
the safe direction, and a viewer must treat a placement edit as invalidating. A mask is `{ productId, surfaceFingerprint, triangles }` with
source triangle ordinals in the same order as `sourceIndices`.

The planner never reuses triangle ordinals by position. Faults in one mask
exclude only that product, in `exclusions`, and the rest of the scope still
plans: a fingerprint that differs from the surface about to be authored is
`Face selection is stale: the evaluated surface geometry changed`; an empty
mask, an ordinal beyond the surface, and a mask on a product that already has
a direct tessellated Body each have their own reason. Faults in the request
shape refuse the whole plan as an error before any source work: masks under
the preserve policy, a mask outside the scope, two masks for one product, more
masks than products, a fingerprint that is not a hex SHA-256 digest, or more
than 500 000 triangle ordinals across all masks (the plan geometry budget's
triangle capacity, checked before any ordinal is sorted). A mask covering every triangle is an
ordinary whole-surface conversion and reports no split.

A partial mask authors one shared `IfcCartesianPointList3D` and two
`IfcTriangulatedFaceSet` items under the same Body wrapper: the masked face set
receives the image or page atlas, the retained face set keeps the complementary
triangles and a new `IfcStyledItem` pointing at the original source surface
style entity. Both keep the source colour and material name through the
canonical funnel, and each must reproduce its share of the source corners
exactly before the plan leaves Rust. The conversion reports `maskedTriangles`
(ascending) and `retainedGeometryItemId`; `sourceIndices` remains the complete
source surface so preview and history keep one original. Face masks do not
apply to direct tessellated bodies, which would require replacing a file-owned
item; the planner reports such a mask as its own exclusion.

### Face masks in the viewer

The appearance workspace holds one face selection per converted product as
session state only: `{ productId, surfaceFingerprint, triangles }`, bound to
the fingerprint the last plan reported for that product. Selections never
persist to IFC (the output carries the resulting face sets), clear when the
target model changes or reloads, and are spent by Apply (the product then owns
a direct tessellated Body, which cannot carry a mask). A plan request carries
only the masks of products inside its scope, and only under the
`evaluatedOccurrence` policy: while **Convert supported objects to mesh** is
off, the planner would refuse the whole request for carrying masks, so the
selections stay dormant in the session and return with the policy. Masks of
other products wait in the workspace.

Each converted object in the panel shows a row `IFC object #N` (the id is never
truncated), a chip (`all N faces` or `k of N faces selected`) and a
**Select faces** editor over the product's evaluated source surface, the same
`sourcePositions`/`sourceIndices` the plan reports, so editor triangle ordinals
are mask ordinals. In the editor **Pick faces** is the sticky selection mode: a
click toggles one face, a marquee adds the faces whose centres it covers (Alt
removes); **All faces** clears the selection, in the editor and on the row. A
selection covering every face is no selection. Every change re-plans, and the
editor keeps its renderer and camera across selection changes and re-plans that
reproduce the same surface (same fingerprint, same placed corners); only a
changed surface rebuilds it.

**Pick in model** keeps the main viewport in a sticky face-pick mode. Each click
must resolve the open product's federation model, one of its source/textured/
retained representation items, and a canonical evaluated-surface triangle; a
miss, another object, or absent/ambiguous provenance changes no selection and
shows a diagnostic. Hidden and isolated objects and section/crop-clipped faces
follow the same visibility rules as the rendered frame. Masked preview parts
retain full-surface corner ordinals, so clicking the retained half after a split
does not restart numbering at zero.

The viewer never decides staleness itself. After every plan it reconciles: a
mask whose product the planner excluded as `Face selection is stale` (an
edited opening, a different profile, a different tessellator) or as already
carrying a direct Body is dropped, and the panel shows `Face selection for
<object> is stale: the evaluated surface geometry changed, so the selection was
cleared. Select faces again.` beside the exclusions; the plan then re-runs
without it, and the diagnostic stays through that automatic re-plan until the
next selection change, Discard or Apply. A conversion that reports a different
fingerprint than the mask it was drawn on is treated the same way. Which edits
change the fingerprint is the planner's call, and the viewer only relays it.
Measured on this build: a geometry edit (a widened box profile) reports the
mask stale; an ordinary (12.345, 67.891, 0.1) m translation of the same swept
box or of a mapped quad keeps the fingerprint in the wasm planner (the authored
coordinates are rebuilt around a per-element origin), while the native Rust
unit test of the same fixture asserts the translated box stale. Native and wasm
currently differ in the fingerprint's placement sensitivity — tracked as
[#4550](https://github.com/LTplus-AG/ifc-lite/issues/4550). Either verdict is
safe for a mask (kept only when the planner reproduces the identical surface
identity, otherwise dropped with the diagnostic), and the viewer test asserts
that invariant rather than either verdict.

The renderer preview stages a masked plan through an explicit
`AppearancePartition`: each resident fragment contributes a textured subset, a
retained subset, or both. Every part has a side-local `partId`, so several
streaming fragments may retain the same IFC `geometryItemId` without becoming
ambiguous. The partition also names the canonical source item, its complete
triangle count and the canonical triangle ordinals carried by every fragment.
Each mesh keeps the complete `appearanceSource.sourceIndices` plus its
current-corner-to-canonical-corner map. Later viewport hits therefore remain
full-surface ordinals rather than becoming subset-local ordinals.

Before installing any GPU part, the renderer proves that both sides provide
disjoint complete coverage of at most 500,000 canonical triangles, that every
declared part matches its corner map, and that owner, model, placement and exact
corner positions are unchanged. Missing, overlapping, reordered or detached
provenance is refused. Compare and Discard restore every original fragment;
Apply commits the generated parts; history validates the live side and inverts
the same partition to join on Undo and split again on Redo. Retained fragments
keep their previous UV, texture and style references. Empty selected or
retained halves are omitted per fragment. Picking any generated part selects
the product; a portable
IFCZIP export carries the image; reopening the export tessellates the product
into its two face sets under one selectable product. Real-browser and
independent-reader evidence, including a masked opening-bearing slab, is in
[`evidence/evaluated-occurrences/face-mask-ui/`](evidence/evaluated-occurrences/face-mask-ui/README.md).
