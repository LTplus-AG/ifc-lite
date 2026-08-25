---
"@ifc-lite/export": patch
---

Stop rewriting `IfcProjectedCRS.MapUnit` to metres.

`normalizeMapUnitName` tested for the SUBSTRING `METRE`, so `MILLIMETRE`, `CENTIMETRE` and `KILOMETRE` all collapsed to a plain metre, and every other unrecognised unit fell through to a synthesised `IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`. A millimetre map unit produced bytes identical to a metre one — a silent 1000x error in the attribute a georeference hangs on.

A prefixed SI metre now keeps its prefix and reuses a matching unit already in the file. A unit the exporter cannot express (`INCH`, a vendor label) leaves `MapUnit` unset — schema-valid, since it is `OPTIONAL` — and reports it in `stats.warnings` rather than claiming metres. `FOOT` and `US SURVEY FOOT` are unchanged.
