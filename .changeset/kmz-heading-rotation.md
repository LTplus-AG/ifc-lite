---
'@ifc-lite/geometry': patch
---

Fix KMZ export placing the model 90° off true orientation in Google Earth.

`ifc_angle_to_kml_heading` (`rust/export/src/kmz.rs`) converted the `IfcMapConversion` X-axis (grid-north) into a KML `<Model><Orientation><heading>` by computing the axis's compass **bearing** (`90 - angle_from_east_ccw`, clockwise from north). KML's `heading` is not a bearing: it's a clockwise **rotation** applied to a model whose local X-axis starts pointing east (heading `0`), so a model whose X-axis should point at true bearing `B` needs `heading = B - 90`, not `B`. Every KMZ export with a rotated `IfcMapConversion` X-axis (i.e. every model whose grid north differs from true north) was placed 90° off in Google Earth.

Fix: `heading = -angle_from_east_ccw` (mod 360), equivalently `(360 - angle_from_east_ccw) mod 360`, instead of `90 - angle_from_east_ccw`. A negative-zero result (X-axis exactly on east, angle `0`) is folded back to `+0.0` so it doesn't render as `<heading>-0</heading>`.

No KMZ/KML importer exists anywhere in this repo, so there was no compensating inverse conversion — previously-exported KMZ files with a non-identity grid-north axis are genuinely off by 90° in Google Earth and should be re-exported.
