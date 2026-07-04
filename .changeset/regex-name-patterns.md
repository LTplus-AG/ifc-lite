---
"@ifc-lite/lists": minor
"@ifc-lite/sdk": minor
---

Support Bonsai-style `/regex/` patterns for property-set / quantity-set and property / quantity names. A name wrapped in slashes (e.g. `/Qto_.*BaseQuantities/`, optionally with flags like `/qto_.*/i`) is matched as a regular expression; a plain name stays an exact match. This lets one list column or query read a value across several matching sets at once, for example `NetVolume` from `Qto_WallBaseQuantities` AND `Qto_SlabBaseQuantities` (issue #1591). Applies to `@ifc-lite/lists` column extraction and filter conditions and to the SDK `bim.query().property()` / `quantity()` getters. `@ifc-lite/lists` exports the new `compileNameMatcher` / `isNamePattern` helpers.
