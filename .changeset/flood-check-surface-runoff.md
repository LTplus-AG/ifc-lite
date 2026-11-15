---
'@ifc-lite/flood-check': minor
---

Add `@ifc-lite/flood-check`: a headless check of a georeferenced building model against a surface-runoff hazard map. It reads doors, windows, openings, light wells, external stairs and ramps, and technical equipment in the lowest storeys from a parsed model (no meshing), samples the hazard class on the ground next to each, and reports per element whether its threshold or sill is clear of the class, exposed, or undecidable from a class range, with every number behind the outcome. Ships a provider for the Swiss BAFU "Gefährdungskarte Oberflächenabfluss" (WMS GetMap with exact legend-colour decoding; antialiased edges stay unclassified and a changed style throws), injectable terrain, refusals for missing or mismatched georeferencing and vertical datum, the publisher's German and English disclaimer and attribution, and `IfcLite_SurfaceRunoffHazardSite` / `IfcLite_SurfaceRunoffExposure` property-set payloads for a later writer.
