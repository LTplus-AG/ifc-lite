---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

Read a LandXML terrain's CRS from `CoordinateSystem/@epsgCode` (follow-up to #5942). `epsgCode` is LandXML 1.2's attribute for the CRS code and is how producers declare it (Civil 3D 2021/2022 and 3D-Win 6.6.4 all write it); it was dropped by the parser, so every real terrain was treated as having no CRS: its imagery drape was refused, CRS federation had nothing to place it by, and the IFC4X3 export wrote no `IfcProjectedCRS`. The parser now keeps `epsgCode` (raw, unresolved), the viewer takes the horizontal CRS from it or from an `EPSG:<n>` `horizontalDatum` (neither when the two disagree), and the export names that `EPSG:<n>` as `IfcProjectedCRS.Name`.
