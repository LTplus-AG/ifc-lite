---
"@ifc-lite/export": patch
---

Stop rewriting `IfcProjectedCRS.MapUnit` to metres.

`normalizeMapUnitName` tested for the SUBSTRING `METRE`, so `MILLIMETRE`, `CENTIMETRE` and `KILOMETRE` all collapsed to a plain metre, and every other unrecognised unit fell through to a synthesised `IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`. A millimetre map unit produced bytes identical to a metre one — a silent 1000x error in the attribute a georeference hangs on.

A prefixed SI metre now keeps its prefix and reuses a matching unit already in the file. A unit the exporter cannot express (`INCH`, a vendor label) leaves `MapUnit` unset — schema-valid, since it is `OPTIONAL` — and reports it in `stats.warnings` rather than claiming metres.

The foot half of the same test was `includes('FOOT') || includes('FEET')`, and it is fixed the same way: normalise, then match exactly. Labels that merely contain a foot token no longer receive the international foot's 0.3048 m — `SQUARE FOOT` and `CUBIC FEET` (an area and a volume, so a wrong dimension rather than a wrong magnitude), `FOOTCANDLE`, `FOOT-POUND`, `FOOTPRINT`, and the national survey feet `SURVEY FOOT`, `CLARKE'S FOOT`, `INDIAN FOOT`, `SEARS FOOT` and `BRITISH FOOT (1936)`, which are five different ratios. `SQUARE US SURVEY FOOT` and `NON-US SURVEY FOOT` no longer resolve as the US survey foot. All of them leave `MapUnit` unset with a warning.

Recognisable spellings still resolve, in any case, with any separators and with one plural suffix: `FEET`, `foot (US survey)`, `SURVEY FEET (US)`, `USSURVEYFT`, `FTUS`, `METRES`, `MILLIMETERS`. `US FOOT` and `USFOOT` now resolve to the US survey foot (1200/3937 m) rather than the international foot — EPSG 9003 is the only US foot.
