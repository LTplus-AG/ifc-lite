---
"@ifc-lite/clash": patch
---

`runClash` now rejects a non-finite `settings.tolerance`, per-rule `rule.tolerance`, or `rule.clearance` (e.g. `NaN` from `Number('abc')` on a cleared input, or a unit-conversion division by zero) instead of letting `??` pass it through unchanged. A non-finite tolerance previously NaN-poisoned the broad-phase bounds, so the geometry pass silently examined zero candidate pairs while `ruleCoverage`'s selector-match counts still read as full coverage — `classifyRuleCoverage` reported `'clean'` having checked nothing.

`ClashRuleCoverage` also gains optional `candidatesProcessed` / `candidatesDropped` fields, threaded from the kernel's `RuleDetection`, so a caller can now tell "checked hundreds of pairs, found nothing" apart from "checked zero" — the distinction `matchedA`/`matchedB` alone (computed before geometry runs) could not make. Additive; existing consumers are unaffected.

`classifyRuleCoverage` now reads that new evidence: previously a rule with full selector coverage (`matchedA`/`matchedB` both non-zero) always classified as `'clean'` even when the geometry kernel examined zero candidate pairs for it — the exact shape a non-finite tolerance (or an exhausted `maxCandidatePairs` budget) produces. Such a rule now classifies as `'partial'` instead of `'clean'`; a rule that both matched its selectors and had pairs to examine still classifies as `'clean'`, and a rule with a genuinely empty side still classifies as `'no-match'`, unchanged.
