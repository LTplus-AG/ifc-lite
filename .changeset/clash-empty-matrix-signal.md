---
"@ifc-lite/clash": minor
"@ifc-lite/cli": patch
"@ifc-lite/viewer": patch
---

Distinguish "the clash matrix found nothing" from "the clash matrix had nothing to check".

The built-in discipline matrix (`--matrix`) is shaped for MEP/HVAC/electrical/fire coordination: every preset's `selectorA` is one of those disciplines. Run it on a model with none of those element types — an infrastructure model, for instance — and every rule matches zero elements on the A side, so the matrix silently reports "0 clashes". That reads as "this model is clean" when it actually means no rule ever ran a real comparison.

`ClashResult` now carries a `ruleCoverage` field (per-rule counts of matched elements on each side), and `@ifc-lite/clash` exports `classifyRuleCoverage`/`ruleHadNoMatch` to turn that into one of `clean` / `partial` / `no-match` / `unknown`. The CLI's `--matrix` (and any other rule set) prints a loud `WARNING` when no rule matched anything, and a shorter note when some rules did not, in both the human summary and the `--json` output (`ruleCoverageOutcome` + `ruleCoverage`); the viewer's clash panel shows the same warning in place of the "No clashes found 🎉" empty state. Zero clashes is never treated as an error — the CLI still exits 0 — this only makes the *kind* of zero visible.

Out of scope: adding infrastructure-discipline presets to the built-in matrix. That's a product decision about what an infra clash matrix should contain, not something to bundle into a diagnostic fix.
