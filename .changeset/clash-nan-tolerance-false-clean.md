---
"@ifc-lite/clash": patch
---

`runClash` now rejects a non-finite `settings.tolerance`, per-rule `rule.tolerance`, or `rule.clearance` (e.g. `NaN` from `Number('abc')` on a cleared input, or a unit-conversion division by zero) instead of letting `??` pass it through unchanged. A non-finite tolerance previously NaN-poisoned the broad-phase bounds, so the geometry pass silently examined zero candidate pairs while `ruleCoverage`'s selector-match counts still read as full coverage — `classifyRuleCoverage` reported `'clean'` having checked nothing.

`ClashRuleCoverage` also gains optional `candidatesProcessed` / `candidatesDropped` fields, threaded from the kernel's `RuleDetection`, so a caller can now tell "checked hundreds of pairs, found nothing" apart from "checked zero" — the distinction `matchedA`/`matchedB` alone (computed before geometry runs) could not make. Additive; existing consumers are unaffected.
