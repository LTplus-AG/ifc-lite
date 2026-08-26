---
'@ifc-lite/parser': patch
---

Exact-match the `ePSet_ProjectedCRS.MapUnit` label instead of substring-sniffing it

`inferMapUnitScaleFromLabel` tested `MILLI`/`CENTI`/`DECI`/`KILO` and then fell
through to `includes('METRE')`. That substring is satisfied by every prefixed
spelling, so a `DECAMETRE` map unit resolved to a scale of `1` instead of `10`,
`HECTOMETRE` to `1` instead of `100`, and `MICROMETRE` to `1` instead of `1e-6`
— a silent error in the CRS scale by the prefix's own factor. `SQUARE METRE`,
an area unit, also resolved to `1`.

The label is now folded to its alphanumerics and matched exactly against a set
derived from the `IfcSIPrefix` EXPRESS enumeration (all sixteen members crossed
with the METRE/METER spellings), the unprefixed base, and the shared
conversion-based length units. Labels with no exact answer resolve to
`undefined`, which is the documented ePSet convention: the project length unit
applies downstream. Declining is deliberate — an absent MapUnit has a defined
meaning, a wrong one relocates the model.

The Rust twin (`ifc_lite_core::GeoRefExtractor`) carried the identical
substring bug and is fixed the same way, so both halves were wrong together;
the shared cross-language fixture now pins the behaviour to the enumeration
rather than to either implementation.

The exact match runs on a NORMALISED label, not the raw one: `MapUnit` is
exporter free text, so case, separators, the English plural and the several
word orders of the US survey foot are all ordinary real spellings. `METRES`,
`Meters`, `MILLIMETRES`, `KILOMETERS`, `INCHES`, `foot (US survey)` and
`SURVEY FEET (US)` therefore resolve; refusing them would have been a new
defect of the opposite kind, silently handing the model back to the project
length unit. `DECAMETRES` resolves to `10`, not to `1` — the normalisation
strips one plural suffix and re-matches EXACTLY, it never collapses a prefixed
spelling onto the base. Still refused: `SQUARE METRE(S)`, `BANANAMETRE`, bare
abbreviations (`M`, `MM`, `MTR`) and a survey foot with no nationality
(`SURVEY FOOT` — the Indian and Clarke feet are different ratios).
