---
"@ifc-lite/ids": patch
---

An IDS bounds restriction (`xs:minInclusive`/`maxInclusive`/`minExclusive`/`maxExclusive`/`totalDigits`/`fractionDigits`) whose `@value` couldn't be parsed — a typo like `"6O"` for `60`, a non-numeric string, or a negative digit-count facet — used to be silently dropped and treated as absent, so the restriction fell back to unbounded and matched every value instead of rejecting the ones it was meant to reject. `parseRestriction` now records which facet failed to parse, `matchBounds` fails closed (rejects every value) whenever that happened instead of silently passing everything, and the failure reason and the `xs:restriction` coherence audit both call out the malformed facet by name so the cause is visible rather than looking like an ordinary value mismatch. A legitimately absent facet, and a well-formed restriction, are unaffected.
