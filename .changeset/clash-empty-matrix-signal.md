---
"@ifc-lite/clash": minor
"@ifc-lite/cli": patch
"@ifc-lite/viewer": patch
---

Distinguish "the clash matrix found nothing" from "the clash matrix had nothing to check".

The built-in discipline matrix (`--matrix`) is shaped for MEP/HVAC/electrical/fire coordination: every preset's `selectorA` is one of those disciplines. Run it on a model with none of those element types — an infrastructure model, for instance — and every rule matches zero elements on the A side, so the matrix silently reports "0 clashes". That reads as "this model is clean" when it actually means no rule ever ran a real comparison.

`ClashResult` now carries a `ruleCoverage` field (per-rule counts of matched elements on each side), and `@ifc-lite/clash` exports `classifyRuleCoverage`/`ruleHadNoMatch` to turn that into one of `clean` / `partial` / `no-match` / `unknown`. The CLI's `--matrix` (and any other rule set) prints a loud `WARNING` when no rule matched anything, and a shorter note when some rules did not, in both the human summary and the `--json` output (`ruleCoverageOutcome` + `ruleCoverage`); the viewer's clash panel shows the same warning in place of the "No clashes found 🎉" empty state. Zero clashes is never treated as an error — the CLI still exits 0 — this only makes the *kind* of zero visible.

The `no-match` warning's wording now depends on whether a real discipline matrix ran. `--matrix` runs many rules, so its "the matrix did NOT run" phrasing is accurate there. The default path (`ifc-lite clash <file> --a <selector> --b <selector>`, no `--matrix`) builds exactly one ad-hoc rule; when only one side's selector matches nothing (e.g. `--a IfcWall --b IfcRoof` on a model with no roofs), the *other* side did match and no matrix was ever involved — the CLI now names the empty selector ("selector B (\"IfcRoof\") matched 0 elements") instead of claiming a matrix that never ran. The viewer's clash panel makes the same distinction for its own single-rule runs (`runAll`'s "Detect all clashes" and a one-off `runPreset`) versus a real multi-rule `runMatrix`.

Out of scope: adding infrastructure-discipline presets to the built-in matrix. That's a product decision about what an infra clash matrix should contain, not something to bundle into a diagnostic fix.
