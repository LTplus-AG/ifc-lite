# Reproduction for Cesium ion placement investigation

Prepared on 2026-10-01. This report has not been sent externally. It contains
public fixture identifiers and observed asset IDs, but no credentials.

## Minimal original IFC

Fetch `tests/models/ifc5/Georeferencing_georeferenced-bridge-deck.ifc` with
`pnpm fixtures`, or download its content-addressed
[public fixture](https://github.com/LTplus-AG/ifc-lite/releases/download/fixtures-v1/6b1de724ceb436759d9cdbe7ce7f4c71734065dfde8cc8786b6239de347de1b1).
SHA-256: `6b1de724ceb436759d9cdbe7ce7f4c71734065dfde8cc8786b6239de347de1b1`.
It is an IfcOpenShell-exported IFC4X3_ADD2 rectangle/extrusion with 33 entities,
EPSG:32610, vertical datum EPSG:5703 and an explicit rotated IfcMapConversion.

Upload unchanged through `POST /v1/assets` with type `3DTILES`, source type
`BIM_CAD`, and the returned storage/completion instructions. Supply string
description and attribution fields. Asset 5969409 completed, but its actual
geometry runs east from the south Golden Gate Bridge approach. The independent
IFC/PROJ midpoint is (-122.4785628774079, 37.81979587989458); the tiled center is
(-122.46599897781184, 37.81065991557522), about 1500.7 m away. The serialized
edited control 5969481 has the same transform/bounds and retained its Name edit.

## Isolate vertical scale

Using IfcOpenShell, change only the original map conversion's Scale to 2:

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
The discrepancy persists using GEOID99 and GEOID18 operations and exceeds
their stated accuracy bounds. API acceptance of this WKT did not establish
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
