---
'@ifc-lite/georef-check': minor
'@ifc-lite/parser': minor
---

New package `@ifc-lite/georef-check` says what is wrong with a model's georeferencing and how to fix it. `diagnoseGeoreference(facts, { reprojector?, crsCatalog? })` is a pure function that returns the Levels of Georeferencing found (LoGeoRef 10 to 50) and a list of findings. Each finding has a stable code, a severity, a one-sentence explanation, the numbers it is based on, and structured fixes (which field to set to what). It covers the map position applied twice, Scale and unit slips, a UTM zone number in front of the Easting, LV03 numbers in an LV95 model, positions outside the CRS's area, authoring-tool default site locations, site latitude/longitude that contradicts the map conversion, a missing or unresolvable CRS, a missing MapUnit or vertical datum, invalid rotations, sources that disagree, and IFC2X3 without the ePSet convention. `collectGeorefFacts(store)` reads the facts from a parsed `IfcDataStore` without meshing.

`@ifc-lite/parser` adds `extractGeoreferenceCandidates` and `extractGeoreferenceCandidatesOnDemand`. They return every georeferencing source in a file (IFC4 entities, `ePSet_MapConversion`, the IfcSite reference point, every IfcMapConversion) instead of only the one that wins. `extractGeoreferencing` and `extractGeoreferencingOnDemand` are unchanged.
