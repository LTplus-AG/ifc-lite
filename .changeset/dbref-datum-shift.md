---
'@ifc-lite/data': patch
'@ifc-lite/viewer': patch
---

Place DB_REF models correctly (#7658). The bundled definitions for EPSG:5682-5685 (DB_REF / Gauss-Kruger zones 2-5) carried the Coordinate Frame rotation signs, and the DB_REF2003/DB_REF2016 compounds EPSG:9928-9935 had no datum shift at all, so an IfcMapConversion landed 140-185 m off. All twelve now use the Position Vector `+towgs84` of EPSG:5826 and agree with PROJ to about 1 cm. The georeferencing panel also warns when IfcSite RefLatitude/RefLongitude is more than 5 m from the position derived from IfcMapConversion.
