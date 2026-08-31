---
'@ifc-lite/lens': patch
---

Fix `matchesCriteria` treating an absent property/attribute as if it equalled the empty string under `equals`/`contains`. `matchesProperty` and `matchesAttribute` checked `contains`/`equals` before checking whether the value was present, so `String(value ?? '')` coerced a missing property/attribute to `''`, and `''.includes('')` / `'' === ''` made a rule like `{ propertyName: 'FireRating', operator: 'equals', propertyValue: '' }` match every entity that never had `FireRating` at all — the same class of "absent value satisfies a comparison it shouldn't" that the numeric operators and `ne` already guard against. `matchesQuantity` already checked presence before any operator and never had this hole; `matchesProperty`/`matchesAttribute` now check presence first too, so absence never satisfies `equals`/`contains` either, matching `matchesQuantity`'s existing behaviour. A property/attribute whose value genuinely is the empty string is unaffected.
