---
'@ifc-lite/mcp': patch
---

`materialFallbackName` (shared by `materials_list`, `count_entities` group_by material, `query_entities`'s per-entity material label, `viewer_get_selection`'s text summary, and the `materials` resource) chained its candidates with `??`, which only falls through on `null`/`undefined`. A material whose `Name` is present but blank (`IFCMATERIAL('',$,$)`), or whitespace-only (a real shape — see #3714), short-circuited the chain and was returned verbatim instead of falling through to the next candidate or the caller's own `(unnamed)`/`(no material)` placeholder — a blank row in a material schedule instead of a labelled unknown. Every candidate in the chain, including the layer/profile/constituent `.find()` predicates, is now checked against a blank/whitespace-only test; the function still returns `undefined` (not a hardcoded placeholder) when every candidate is absent, so each caller's own wording still applies.
