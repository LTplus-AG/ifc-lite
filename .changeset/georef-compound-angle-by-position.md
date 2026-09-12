---
"@ifc-lite/parser": patch
---

The legacy `IfcSite` georeference fallback reads `RefLatitude`/`RefLongitude` components by position and refuses the angle when a component is not a number. It used to drop non-numeric components and index what was left, so `($,51,30,0)` placed the site at 51°30' instead of reporting no georeference. The Rust extractor applies the same rule, and both are held to it by the shared georeferencing vectors.
