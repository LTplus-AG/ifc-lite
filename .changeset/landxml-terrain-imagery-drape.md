---
"@ifc-lite/viewer": minor
---

Drape georeferenced imagery on a loaded LandXML terrain (#5942, mapping spec §15). Drop a GeoTIFF, or a PNG/JPEG with its world file and `.prj`/`.aux.xml`, and it is placed by the same CRS contract federation uses (reprojected exactly when its CRS differs, refused when it cannot be), projected onto every TIN vertex in the terrain's CRS, and rendered through the existing textured-mesh path; beyond the image the terrain keeps its flat colour. The card reports the image CRS, ground sample distance and the fraction of terrain vertices covered. A terrain with no declared EPSG CRS, or an image with no world file or CRS, is refused rather than placed by its pixel bounds.
