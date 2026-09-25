---
"@ifc-lite/viewer": minor
---

Drape XYZ map tiles or a WMS image on a LandXML terrain from its properties card (#5942, mapping spec §15.1). An XYZ mosaic is placed exactly on the EPSG:3857 tile grid and reprojected into the terrain's CRS; a WMS image is requested with WMS 1.1.1 in the terrain's own CRS, whose bounding box is always easting-first. Tile drapes are viewer-only and are never written to an export.
