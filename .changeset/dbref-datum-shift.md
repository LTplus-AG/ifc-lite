---
'@ifc-lite/data': patch
---

Place DB_REF models correctly (#7658). The bundled definitions for EPSG:5682-5685 (DB_REF / Gauss-Kruger zones 2-5) carried the Coordinate Frame rotation signs, and the DB_REF2003/DB_REF2016 compounds EPSG:9928-9935 and the geographic EPSG:5681/5830 and geocentric EPSG:5828 had no datum shift at all, so an IfcMapConversion landed 140-185 m off. All fifteen now use the Position Vector `+towgs84` of EPSG:5826 and agree with PROJ (about 1 cm measured; the tests allow 0.5 m). The EPSG index generator now re-applies these and the earlier #2904 corrections after every fetch, so a regeneration cannot revert them.
