# Cesium ion placement acceptance: issue #6587

Observed on 2026-10-01 using an authorized real account and the catalogued
IfcOpenShell `Georeferencing_georeferenced-bridge-deck.ifc` regression model.
Fetch the model with `pnpm fixtures`. Credentials are not included here.

## Client normalization re-audit

The earlier mismatches are observations, not proof of a provider defect.
A fresh review identified ambiguous deck CRS metadata and tested equivalent
IFC encodings before escalation. The original SketchUp Infra-Bridge model
now tiles as asset **5970022** after normalizing only its map units to metres:
`MapUnit = METRE`, and `Eastings`, `Northings`, `OrthogonalHeight`, `Scale`
multiplied by 0.001. Project units and all 48 products' geometry/indices stay
unchanged. Independent mapped-vertex equivalence is within 1.87e-9 m.

The actual tiled root's longitude/latitude match the authored origin exactly
at printed precision: (179.08012899993923, -8.462489999999077). CesiumJS 1.145
loaded all four actual GLBs and their external schema dependencies: 48 metadata
features and 13,292 rendered triangles. Only schema URIs were localized;
binary geometry and cumulative tile transforms were preserved. An independent decoder compared all 48 products: bidirectional referenced
vertex differences are at most 1.255 mm, below the 1.810 mm quantization step;
per-axis bounds differences are below 0.585 mm. Triangle counts differ, so
this does not assert identical connectivity. See the [numeric proof](./infra-map-unit-normalized-proof.json).
Production asset **5970083** has now passed the actual viewer route: load the
original model, edit IfcBeam #288 in Author > Model, upload through the real
Ion dialog/transport, and inspect the complete asset. Its tiled Name is
`Ion normalization acceptance edited girder`; all 48 GUIDs and 47 other Names
match the source. Genuine meshopt decoding establishes exact render-accessor,
index, scene/node, material, feature-association and complete tile-transform
identity against verified control 5970022. Full GLB hashes differ because
metadata changed. All four GLBs render in CesiumJS; the token field was masked
and cleared after submission. The user also confirmed the Cesium view looks good.
The [numeric proof](./infra-map-unit-normalized-proof.json) records this separately
from the original unedited control.

![Production tiled model with the actual Name edit](infra-production-edited.png)

![Actual normalized Infra-Bridge asset rendered by CesiumJS](infra-map-unit-normalized.png)

The deck's `VerticalDatum = EPSG:5703` names a vertical CRS, not the datum
identifier expected by [IfcProjectedCRS](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcProjectedCRS.htm).
Correcting its compound CRS (5970016), or baking its map transform into ordinary
geometry with datum EPSG:5103 (5970020), produced `DATA_ERROR` at 5%, so those
controls do not establish correct placement. The client integration review and
required-check history are recorded in [PR #6606](https://github.com/LTplus-AG/ifc-lite/pull/6606); this work is not
blocked on provider support.


## Equivalent mapped geometry fixes the deck

Control **5970044** preserved the original deck CRS metadata and source
profile, wrapped its representation in a standard `IfcMappedItem` carrying
the full authored similarity transform, and reset `IfcMapConversion` rotation
and scale to identity. Its independently mapped source corners are exactly
equal to the original fixture. The actual tiled GLB's eight unique corners
agree with the full source/GEOID99 oracle within 1.75 cm, below its 3.08 cm
quantization step. The alternative GEOID18 residual (0.451 m) is disclosed;
provider geoid selection is not identified. See the [numeric proof](./mapped-deck-normalized-proof.json).

The full GLB and external schema render in CesiumJS with the actual tile
transform and no additional placement correction. The deck follows the
Golden Gate Bridge north–south. Original `VerticalDatum = EPSG:5703` was
retained to isolate geometry normalization; this control does not certify
that metadata as semantically correct.

Production SDK asset **5970221** now verifies the generic Rust-backed export
with both normalization options and an effective Name edit. IfcOpenShell
confirms exact mapped-corner equivalence and no EXPRESS validation messages.
The downloaded tiles retain the edited Name and GlobalId; their actual geometry
payloads, decoder parameters, accessors, materials, scene and tile frames exactly
match the independently verified control. CesiumJS renders the deck along the
Golden Gate Bridge using only its downloaded transform. The [numeric proof](./mapped-deck-normalized-proof.json)
records this SDK route separately. The final combined viewer route also passed as asset **5972000**: the original public deck was loaded, its Name edited in Author, and the actual masked-token dialog submitted it through the production transport. Downloaded metadata retains `Ion combined UI compatibility edited deck` and the original GUID. All encoded geometry, decoder/accessor contracts, scene/material/feature contracts and full tile frames exactly match verified SDK asset 5970221. CesiumJS renders its twelve triangles without errors using only the downloaded transform. The token was cleared while the prominent named asset link remained visible. Native screenshot capture failed for this new asset, so no new screenshot or visual inspection is claimed; its actual geometry is identical to the visually verified reference below. Published UI review and required-check history are recorded in [PR #6606](https://github.com/LTplus-AG/ifc-lite/pull/6606).

![Production SDK export tiled at the Golden Gate Bridge](production-deck-normalized.png)

![Actual mapped deck following the Golden Gate Bridge](mapped-deck-normalized.png)

## Real ribbon entry and dialog

On source head `d90afc7362ec768c8a107544667777e1bf9349bf`, the supported
CI browser project loaded `building-architecture.ifc`, verified all 87 ribbon
commands at 1280 px, and opened the one Cesium ion command. The actual dialog
selected the loaded model, used a password input and disabled Upload without
a token. Closing it succeeded. This local browser regression passed; it made
no account requests. The screenshot contains an empty credential field.

![Actual Ion dialog with selected IFC and empty masked token input](ion-upload-dialog.png)

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

## Documented input CRS experiment

Asset **5969729** (collection 5969728) preserved the original IFC and supplied
the documented `inputCrs` option as WKT for a `DerivedProjectedCRS`, using the
EPSG:9624 affine conversion and EPSG:32610 base CRS. An independently evaluated
PROJ conversion included the authored rotation and scale. This is a test-only
option, not behavior shipped by the upload implementation.

An initial derived CRS control, **5969702**, tiled in the Pacific. Comparing its
actual center with PROJ showed that the tiler applies the IFC's Eastings and
Northings before evaluating the override. The second experiment accounted for
that observed input frame in the affine translation. It reached `COMPLETE`,
100%, and its actual tiles rendered along the Golden Gate Bridge without a
CesiumJS model-matrix adjustment.

![Actual tiles from the anchored input CRS experiment following the bridge](anchored-crs-control.png)

Its bounding-sphere center was longitude -122.47856287106258, latitude
37.81979588145428, ellipsoidal height 67.41936655631595 metres. The horizontal
center agrees with the independent source midpoint within a millimetre.
This is a separate CesiumJS rendering of the actual output, not the signed-in
ion dashboard. It establishes a promising horizontal correction for this
fixture; it does not verify vertical datum conversion, units other than metres,
already transformed source geometry, or other IFC georeferencing variants.
The source declares EPSG:5703 as its vertical CRS, and its elevation still needs
independent verification before claiming full placement acceptance.

Option contract: [Cesium ion OpenAPI](https://ion.cesium.com/openapi.yaml).
Affine operation: [PROJ affine transformation documentation](https://proj.org/en/stable/operations/transformations/affine.html).

## Compound vertical CRS control

Asset **5969770** (collection 5969769) retained the unchanged IFC and supplied
the same anchored horizontal CRS within a `CompoundCRS` with EPSG:5703 NAVD88.
It reached `COMPLETE`, 100%. Its actual tiled center was longitude
-122.47856287106673, latitude 37.819795881485646, ellipsoidal height
34.438104219298346 metres. It retained the northward alignment. The horizontal
center still agrees with the independent source midpoint within a millimetre.

![Actual compound CRS tiles following the bridge](compound-crs-control.png)

For an independent vertical check, PROJ 9.3 / pyproj 3.6.1 used the source
EPSG:32610 + EPSG:5703 compound CRS, target EPSG:4979, a San Francisco area of
interest, and `allow_ballpark=False`. Downloaded public PROJ/NOAA grids made real
vertical operations available. At the nominal source midpoint and
`0.9996 * 67.5` metre orthometric height, the available GEOID99 operation
returned 34.4881148179993 metres (reported expected accuracy 2.05 metres); GEOID18
returned 34.924909672373786 metres (reported expected accuracy 4.015 metres).
The tiled center is consistent with those independent operations, but this does not
identify ion's exact grid, establish centimetre elevation accuracy, or prove
that its handling of vertical map scale is correct. A bounding-sphere center
is also not an exact mesh-vertex oracle.

The compound override restores a plausible vertical conversion that the
horizontal-only experiment lost. Both experiments remain test-only until
source-unit, map-scale, coordinate-frame and original Infra-Bridge acceptance
cases are verified.

## Unit and scale matrix

Audit qualification: the generated metre, unrotated, Scale = 2 and elevated
controls below contain `1E-05` for context `Precision`, whereas STEP REAL syntax
requires a decimal point in the mantissa
(`1.E-05`). IfcOpenShell accepted their geometry, but these uploads do not by
themselves establish a standards-conforming scale reproduction. The corrected
control is recorded below. The unchanged public fixture used for the
original orientation failure contains the valid literal.

Four independently checked IFC variants also reached `COMPLETE`. IfcOpenShell
produced identical eight SI-metre source vertices for the metre and millimetre
variants. The controls preserved source geometry and used the test-only anchored
compound CRS, with parameters derived for each variant.

The millimetre variant uses millimetre project geometry, metre `MapUnit`, and
`Scale = 0.9996 / 1000`. It does not test millimetre map units; the original
Infra-Bridge has both project and map units in millimetres and still fails
acceptance below.

| Control | Asset | Result |
| --- | --- | --- |
| Millimetre geometry, metre map units | 5969785 | Horizontal placement agrees; vertical scale still unverified by center alone |
| Unrotated horizontal axis | 5969787 | Horizontal placement agrees |
| Map Scale = 2 | 5969784 | Incorrect elevation: canonical vertices lie up to 68 m outside the tiled bounding box |
| Local elevation +100 m, OrthogonalHeight = 23 m | 5969789 | Vertical translation retained; scale discrepancy remains |

The stronger scale check transforms all eight authored corners through the
canonical IFC scale/rotation/translation and a no-ballpark PROJ vertical grid
operation into ECEF, then into the actual tileset's root frame. It compares
those vertices with ion's declared containing bounding box, rather than
comparing two bounding centers. With GEOID99, the Scale = 2 expected vertices
fall outside the actual box by up to 67.9999999999 m; GEOID18 also puts them
outside by about 68.44 m, well beyond either operation's reported expected accuracy.
The actual box remains around the unscaled local height. The 2D affine override
therefore cannot represent IFC's scale of all three coordinates. Successful
horizontal and vertical-datum controls do not make this route merge-ready.

## Full derived vertical CRS attempt

A `DerivedVerticalCRS` using the standard EPSG:9616 vertical offset, together
with the derived vertical axis's length-unit factor, independently represented
the complete source vertical affine transform. PROJ evaluated all six fixtures'
eight corners against their canonical IFC map operations within 1.9e-8 m.
This offline result is not ion acceptance.

Actual source-preserving controls **5969809** (Scale = 2) and **5969808**
(elevated, nonzero OrthogonalHeight) reached `COMPLETE` with that full compound
WKT. Their root transforms and bounding volumes remained effectively identical
to the earlier 2D-compound controls, including the unscaled height in the
Scale = 2 case. The standard vertical derivation was therefore not reflected
in this observed tiler bounding output. Do not ship it based on API acceptance or the
successful independent PROJ evaluation.

### Corrected STEP REAL control

The corrected Scale = 2 source has SHA-256
`970100f73a188cbcda65e0ba147cb2be0646643fe9f0bf84de200819feac3434`.
Its REAL literals pass a separate lexical audit, and IfcOpenShell schema
validation reports no messages. Changing `1E-05` to `1.E-05` preserves the
checked typed attributes; an independent IfcOpenShell extraction produced
eight vertices and twelve triangles. An earlier scratch comparison recorded
empty vertex arrays and is not used as geometry evidence. Asset **5969891**
reached `COMPLETE` using the same full compound CRS. Its root transform and
bounding box retain the prior scale failure: independently mapped corners are
up to 67.99999999948 m outside the containing box using GEOID99, or 68.436140759 m
using GEOID18. Those operations report expected accuracies of 2.05 m and
4.015 m, respectively; these are not guaranteed error bounds. The root basis
is orthonormal to floating-point precision, supporting the inverse-frame check.
No client transform was applied. This corrected control demonstrates that the
lexical defect did not account for the observed placement/bounds discrepancy.
The containing-box test alone did not distinguish wrong mesh positions from
wrong metadata. The subsequent direct mesh check below resolves that limitation.
The [exact source patch](./scale-two-valid-real-from-public.patch) reconstructs
the uploaded bytes from the catalogued public fixture; the
[numeric result](./corrected-scale-two-provider-repro.json) records the source
and WKT hashes, provider frame, independent corners and limitations.

### Direct tiled mesh check

Asset 5969891 contains one 3D Tiles 1.1 root with one GLB, no implicit tiling,
and no tileset/tile/content extensions that add transforms. Two downloads have
identical content hashes. Independent readers using genuine meshopt 1.1.1 and
1.2.0 decoders agree after node dequantization and glTF Y-up to tile Z-up
conversion. The mesh has 24 referenced vertices, eight unique corners and
12 triangles; there is no instancing, skin, morph or extra scene.

Actual root-local Z spans 65.796–68.015 m. Independently mapped source corners
span 132.796–136.000 m using GEOID99, or 133.230–136.437 m using GEOID18.
Every authored corner is 65.984–68.448 m from its nearest actual vertex.
Same-horizontal-corner thickness is 0.986 m instead of the authored 2 m.
The 0.06165 m quantization step explains small differences, including a 0.015 m
expansion beyond the declared box, but cannot explain the vertical discrepancy.
This proves misplaced actual geometry rather than inferring it from bounds.
The [direct mesh comparison](./actual-scale-two-mesh-comparison.json) records
content/source hashes, transforms, actual/expected corners and limitations.

### Rejected three-axis CRS shortcut

Promoting the tested horizontal CRS to three axes retained ellipsoidal height
and left Z unchanged in the offline affine check. It did not add NAVD88.
[OGC Topic 2, sections 9.2 and 9.3.2](https://docs.ogc.org/as/18-005r5/18-005r5.html)
specifies inherited reference frames and prohibits redundant axes in compound
CRSs; a three-dimensional projected CRS plus NAVD88 is not that permitted
horizontal-plus-vertical combination. A [PROJ affine operation](https://proj.org/en/stable/operations/transformations/affine.html)
can scale Z, but an operation alone does not supply the missing datum semantics.
This promotion test established no distinct supported remedy and does not
address the original SketchUp model's ingestion failure.

## Original Infra-Bridge database control

Asset **5969775** (collection 5969773, iModel 5969774) used the unchanged original
SketchUp IFC4 Infra-Bridge and the documented `BIM_CAD_DB` source type with no
CRS override. It reached `COMPLETE`, unlike the original tiler, which failed at
41%. Its actual root transform is centered at ECEF approximately
(6378137, 0, 0), near longitude/latitude 0/0. Its millimetre `IfcMapConversion`
instead declares EPSG:32760 with metre-equivalent Eastings 729011.2258823584
and Northings 9063960.607644705. Tiling this real model is demonstrated;
placement acceptance is still failed. This is a control, not a replacement
transport shipped by the PR.

Two further unchanged-source database controls also tiled. **5969795** supplied
the documented `inputCrs: EPSG:32760`; its root translation was approximately
ECEF (26124.15, 498478.42, -6337257.45), far from the authored location, and its
second transform basis was all zero. **5969814** supplied only the independently
calculated longitude/latitude position (179.08012899993923,
-8.462489999999077, 0). Its output was identical to the native database control,
still near 0/0. Neither passed placement acceptance. Position is documented as
inapplicable when embedded georeferencing is present, so its being ignored does
not establish an API contract violation.

An independent IfcOpenShell run produced 48 source meshes with no geometry
errors. Their SI-metre bounds were approximately (-0.965763, -0.904192, -3.5)
to (44.401270, 56.905256, 7.774582), with project and map units both 0.001 metre.
The source dimensions and canonical map conversion, rather than a matching
origin alone, remain the placement oracle for any proposed replacement.

## Current verdict

The unchanged-source and CRS-override routes above failed placement acceptance.
The explicit standards-based compatibility export passes the independent source
and actual tiled-geometry checks for both regression models, with retained edits
and genuine Cesium renders. The production SDK deck route is asset **5970221**;
the production viewer Infra-Bridge route is **5970083**. The combined upload UI
also passes actual edited-deck tiling/geometry/metadata acceptance as **5972000**;
its published review and required-check history are recorded in [PR #6606](https://github.com/LTplus-AG/ifc-lite/pull/6606).
These successful client-side routes
supersede the earlier blocker; they do not certify every IFC representation or
attribute the original mismatches to a provider defect.
