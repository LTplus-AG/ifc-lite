---
'@ifc-lite/parser': patch
---

The ePSet `MapUnit` reader resolves the US survey foot as exactly 1200/3937 m (it was the truncated `0.3048006096`, about 4e-12 relative), matching the Rust core, which now keeps one definition shared with the exporters. The Rust crates also gain one `IFCPROJECT` locator that returns every project id in file order, a cached `EntityDecoder::project_id()`, `ProjectUnits` carrying the length and plane-angle scalars, and storey elevations in the quick-metadata bootstrap reported in metres.
