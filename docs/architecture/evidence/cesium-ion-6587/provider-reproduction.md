# Reproduction for Cesium ion placement investigation

Prepared on 2026-10-01. This report has not been sent externally. It contains
public fixture identifiers and observed asset IDs, but no credentials.

## Reopened client-side investigation

The observations below do not establish a Cesium defect. A fresh standards
review found that the deck's `VerticalDatum` value `EPSG:5703` identifies a
vertical CRS, whereas IFC defines that attribute as a datum identifier
(NAVD88 datum is `EPSG:5103`). Schema validation alone did not check that
semantic distinction. Supported input normalization must be tested before
escalation. The corrected compound-CRS control 5970016 and datum-corrected,
geometry-baked control 5970020 returned `DATA_ERROR` at 5%; those results
provide no geometry-placement verdict.

A client-side compatibility fix succeeded for the original SketchUp model:
control **5970022** changed its target `MapUnit` from millimetres to metres
and multiplied `Eastings`, `Northings`, `OrthogonalHeight`, and `Scale` by
0.001. It preserved all 48 products' engineering geometry and indices.
Independent physical map-coordinate differences are at most 1.87e-9 m.
The design tiler reached `COMPLETE`; its root origin independently resolves
to longitude 179.08012899993923, latitude -8.462489999999077, matching the
original source. All four actual GLBs and their schema dependencies render
in CesiumJS, with 48 metadata features and 13,292 triangles. Full per-product placement comparison also passed: bidirectional referenced
vertex differences are below 1.255 mm, within the 1.810 mm quantization step.
See the [numeric proof](./infra-map-unit-normalized-proof.json). A production
implementation has passed real edited-model upload acceptance as asset
5970083: the actual Name edit and all 48 GUIDs survive, with exact render
geometry/tile-transform identity against the verified control. PR review and
required checks remain pending. No manual display transform was
introduced.

A second client-side control, **5970044**, uses standard mapped geometry
to carry the deck's full similarity transform. Actual corners agree with the
source/GEOID99 oracle within 1.75 cm (quantization 3.08 cm), and the rendered
deck follows the bridge without a display correction. See the [numeric proof](./mapped-deck-normalized-proof.json).
The generic Rust-backed SDK export is now verified as edited asset **5970221**:
its stored geometry contracts exactly match the verified control, edited metadata
is retained, and the genuine render follows the bridge. The actual combined viewer
upload also passes as edited asset **5972000**, with retained Name/GUID and exact
geometry/tile-frame identity against the SDK reference. Its genuine Cesium render
has twelve triangles and no errors; native screenshot capture failed, so no new
visual inspection is claimed. Final published UI CI and feedback remain pending;
see the current record above.

The report is retained as an investigation record, not a request to attribute
fault to the provider. See [the updated acceptance record](./README.md).

## Minimal original IFC

Fetch `tests/models/ifc5/Georeferencing_georeferenced-bridge-deck.ifc` with
`pnpm fixtures`, or download its content-addressed
[public fixture](https://github.com/LTplus-AG/ifc-lite/releases/download/fixtures-v1/6b1de724ceb436759d9cdbe7ce7f4c71734065dfde8cc8786b6239de347de1b1).
SHA-256: `6b1de724ceb436759d9cdbe7ce7f4c71734065dfde8cc8786b6239de347de1b1`.
It is an IfcOpenShell-exported IFC4X3_ADD2 rectangle/extrusion with 33 entities,
EPSG:32610, a VerticalDatum field containing EPSG:5703, and an explicit rotated IfcMapConversion.

Upload unchanged through `POST /v1/assets` with type `3DTILES`, source type
`BIM_CAD`, and the returned storage/completion instructions. Supply string
description and attribution fields. Asset 5969409 completed, but its actual
geometry runs east from the south Golden Gate Bridge approach. The independent
IFC/PROJ midpoint is (-122.4785628774079, 37.81979587989458); the tiled center is
(-122.46599897781184, 37.81065991557522), about 1500.7 m away. The serialized
edited control 5969481 has the same transform/bounds and retained its Name edit.

## Isolate vertical scale

The following minimal IfcOpenShell recipe changes only the original map
conversion's Scale to 2. It is a proposed reproduction, not the exact source
uploaded for asset 5969809; that generated control also made metre MapUnit
explicit and rewrote numeric formatting.

For the exact corrected source actually uploaded as asset 5969891, apply
[this patch](./scale-two-valid-real-from-public.patch) to the original public
fixture instead. Besides Scale = 2 and explicit metre MapUnit, it includes
a 1e-11 metre profile-center rounding change. Its hash and observed root box,
source corners and independent comparisons are in
[the credential-free result](./corrected-scale-two-provider-repro.json).

```python
import ifcopenshell
model = ifcopenshell.open("Georeferencing_georeferenced-bridge-deck.ifc")
model.by_type("IfcMapConversion")[0].Scale = 2.0
model.write("Scale2.ifc")
```

Supply the [full compound input CRS](./scale-two-full-crs.wkt) as the documented
`inputCrs` option. This definition describes the observed translated input
frame and contains a derived horizontal CRS plus a standard derived vertical
CRS using EPSG:9616 and a length-unit factor. Independent PROJ evaluation
agrees with the complete authored XYZ affine transform within 1.9e-8 m.

Actual asset 5969809 completed, but its vertical bounds remain unscaled and
match the prior 2D compound control 5969784. Independently transformed source
corners lie up to 68 m outside the actual tileset's declared containing box.
The uploaded generated control contained a lexically invalid STEP `Precision`
literal (`1E-05`, missing the mantissa decimal point). Its geometry was accepted
by IfcOpenShell, but this observed asset is not yet a clean standards-conforming
reproduction. The original fixture and the IfcOpenShell mutation recipe above
do not have that lexical defect. Corrected asset **5969891** has since completed
using the same full compound CRS. Its source SHA-256 is
`970100f73a188cbcda65e0ba147cb2be0646643fe9f0bf84de200819feac3434`;
all REAL literals pass a separate lexical audit and IfcOpenShell schema validation
reports no messages. An independent IfcOpenShell extraction produced eight vertices and twelve
triangles; the lexical correction preserves checked typed attributes. An earlier
scratch equality record had empty geometry arrays and is not used as evidence. The corrected tileset still excludes independently mapped
source corners by up to 67.99999999948 m (GEOID99) or 68.436140759 m (GEOID18).
The discrepancy persists using GEOID99 and GEOID18 operations and exceeds
their reported expected accuracy. These accuracy figures are not guaranteed
error bounds. Subsequent direct GLB decoding resolves the metadata-only
ambiguity: the actual mesh has eight unique corners and twelve triangles,
root-local Z 65.796–68.015 m, and slab thickness 0.986 m instead of 2 m.
All authored corners are approximately 66–68 m from their nearest actual
vertices. Independent meshopt decoders agree after node/axis transforms;
the quantization step is only 0.06165 m. There is no implicit content or
additional tile transform. See the [direct mesh evidence](./actual-scale-two-mesh-comparison.json).
API acceptance of this WKT did not establish
support for its derived vertical conversion. No client modelMatrix was applied.

## Original SketchUp IFC4 model

The [public Infra-Bridge fixture](https://github.com/LTplus-AG/ifc-lite/releases/download/fixtures-v1/3d1273bb60bda11373e0bcbd8a73c409f49c097b98867573c9493888d8626fcc)
was exported by SketchUp 2024 / IFC manager 5.3.3, uses IFC4, and declares
millimetre project/map units with EPSG:32760. Independent IfcOpenShell processing
produced 48 meshes without geometry errors. The metre-equivalent map origin
is (729011.2258823584, 9063960.607644705), longitude/latitude
(179.08012899993923, -8.462489999999077).

The original design-tiler asset 5969335 and unchanged-source control 5969394
failed at 41%. Database-tiler asset 5969775 completed but landed near 0/0.
The separate EPSG override 5969795 and position control 5969814 also completed
but failed placement. The latter is consistent with position being ignored
when source georeferencing is present; it is not asserted to violate that API
contract. The original and serialized IFC DATA sections were byte-identical.

## Questions to resolve

- Does the design tiler apply all IfcMapConversion and IfcMapConversionScaled
  XYZ scale, axis rotation and translation, including map-unit conversion?
- Which compound and derived vertical CRS operations are supported by inputCrs?
- Which supported source/options preserve the original Infra-Bridge geometry
  and its authored georeferencing?

The [acceptance record](./README.md) includes screenshots and additional
controls. The desired outcome is correct stored tileset geometry and retained
source edits, with independently verified bounds; a manual/client-only display
transform does not establish that outcome.
