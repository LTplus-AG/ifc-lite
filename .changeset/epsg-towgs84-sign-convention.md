---
'@ifc-lite/data': patch
---

Corrected the `towgs84` Helmert-transform rotation signs for EPSG:31370 (Belgian Lambert 72) and EPSG:3021 (Sweden RT90), and added the missing `towgs84` clause for EPSG:2065 (S-JTSK (Ferro) / Krovak) in the bundled EPSG index. epsg.io's `.proj4` output is not consistent about the Position Vector vs. Coordinate Frame rotation convention, and a rotation triplet published under the wrong convention is syntactically valid but silently mispositions the transform by tens to hundreds of metres.
