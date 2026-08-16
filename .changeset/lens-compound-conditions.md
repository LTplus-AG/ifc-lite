---
"@ifc-lite/lens": minor
---

Compound conditions for lens rules: a rule's criteria can now be `type: "and"` / `type: "or"` with a `conditions` array of member criteria, each a leaf (any of the eight existing criteria types, including the numeric operators) or another nested compound - enough to express Smart-Views-style rules like "IfcWall AND (FireRating >= 60 OR LoadBearing = true)".

Semantics fail closed: an empty or missing `conditions` array matches nothing (for both operators), a member whose data is absent fails its own leaf (an `or` can still match on another member), and nesting beyond the exported `MAX_COMPOUND_DEPTH` (16) matches nothing. A compound with a single member behaves identically to that member as a plain criteria.

The change is additive: every existing rule shape evaluates exactly as before, presets are untouched, and an older build of the engine treats a compound rule as inert (it matches nothing) rather than silently matching something else. Also exports `LENS_COMPOUND_TYPES` (`['and', 'or']`) for rule editors; the viewer's lens panel does not yet author a compound rule, but it does surface one: an imported compound displays a read-only "AND - N conditions" summary, its criteria-type selector is disabled instead of letting an edit silently rewrite it into an unrelated leaf, and it is no longer dropped on save.
