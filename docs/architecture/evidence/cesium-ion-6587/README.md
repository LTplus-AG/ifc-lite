# Cesium ion placement acceptance: issue #6587

Observed on 2026-10-01 using an authorized real account and the catalogued
IfcOpenShell `Georeferencing_georeferenced-bridge-deck.ifc` regression model.
Fetch the model with `pnpm fixtures`. Credentials are not included here.

## Actual tiled geometry

Asset **5969481**, uploaded through the viewer after changing the slab's `Name`
to `Ion acceptance edited bridge deck`, reached `COMPLETE`, 100%. Its downloaded
tiled GLB retained the edit. An unchanged source control, **5969409**, also tiled.
Their root transforms and bounding volumes were identical.

Both were loaded from their actual ion asset endpoints using CesiumJS 1.130,
without changing the tilesets' model matrices, against OpenStreetMap imagery.
The edited asset renders near the Golden Gate Bridge's south approach but runs
east into the bay, rather than following the bridge north.

![Actual edited ion tiles running east from the south bridge approach](edited-deck-ion-tiles.png)

This is a separate CesiumJS rendering of ion's output. It is not a screenshot
of the signed-in ion dashboard. The unchanged source control was also rendered
and showed the same orientation. The source serializer therefore did not cause
this difference, but successful tiling does not establish correct placement.

## Independent horizontal oracle

The source rectangle extends from local X = 0 to 2025.27948635555 metres.
Its `IfcMapConversion` declares EPSG:32610, eastings 545991.679663973,
northings 4184941.96970872, axis
(-0.0977396728779572, 0.995212015776392), and scale 0.9996.
Applying the standard scale/rotation/translation and independently converting
with PROJ produces these longitude/latitude coordinates:

| Point | Longitude | Latitude |
| --- | ---: | ---: |
| Authored start | -122.47750280356061 | 37.81071150267693 |
| Authored midpoint | -122.4785628774079 | 37.81979587989458 |
| Authored end | -122.47962319819858 | 37.82888023549811 |
| Tiled bounding-sphere center | -122.46599897781184 | 37.81065991557522 |

The authored mathematical rotation is 95.6090255829533 degrees. The midpoint
discrepancy is approximately 1500.7 metres. Matching the tiled origin's longitude
and latitude alone missed this orientation defect. Vertical datum conversion
has not been independently verified and is not claimed here.

Transformation semantics: [buildingSMART IfcMapConversion](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcMapConversion.htm).

## GeoBIM options control

Asset **5969648** used the unchanged IFC through the same actual transport,
adding the released fork's `position` and `heading` options only for this test.
The fork computes a compass heading of 354.3909744170467 degrees, rather than
the mathematical rotation above. Required description and attribution strings
were retained so the current API accepted the request.

It tiled, but still ran east. Its midpoint longitude/latitude were effectively
unchanged; the maximum root basis difference was 1.33e-8. The position override
also changed the vertical translation by approximately 33 metres. This does not
support shipping the undocumented heading option as a correction.

## Documented database-tiler control

Asset **5969658** (collection 5969656, iModel 5969657) switched only the documented
source type to `BIM_CAD_DB`, preserving the source IFC and its embedded CRS.
It reached `COMPLETE`, 100%, but its tiled center was approximately longitude
-4.49e-7, latitude -4.52e-7 degrees, near 0/0 instead of San Francisco.
It did not pass placement acceptance and is not a tested replacement.

Supported tiler choices: [Cesium's tiler selection guide](https://cesium.com/learn/bim-cad/tiling-bim-cad-models/bim-cad-tiler-selection-guide/).

## Verdict

Real upload, retained edits, completion handling and named asset navigation are
demonstrated. Automatic placement acceptance remains **failed** for this public
fixture. Keep that distinction explicit in review and user-facing copy; do not
claim correct orientation from a matching origin, silently rewrite the IFC to
work around the service, or treat the fork's best-effort heading as verified.
