---
'@ifc-lite/ids': minor
---

IDS material facets no longer report `MATERIAL_MISSING` for an element that has a material on a server-parsed model (#5227). The contract follows the classification facet's `unresolved` handling (#3948). A proven material association satisfies a presence-only material facet. A value-constrained facet that no readable material satisfies reports the new failure type `MATERIAL_UNRESOLVED`, which is neither `MATERIAL_MISSING` nor `MATERIAL_VALUE_MISMATCH`. That failure **fails** the requirement even when its optionality is `prohibited`, so "cannot verify" is never reported as a pass. `MaterialInfo.name` is now optional, and `MaterialInfo` gains `unresolved`. The failure has a user-facing message in both formatters and in the en/de/fr locales.
