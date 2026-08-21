---
"@ifc-lite/sdk": patch
---

Fix `bim.ids.summarize()` counting a `not_applicable` specification as passed. A specification whose applicability matches zero entities and whose cardinality does not require a match (no `minOccurs`) is neither a pass nor a fail — `@ifc-lite/ids`'s own `validateIDS` report already treats it that way — but `summarize()` had no `not_applicable` bucket, so its unconditional `else` folded every such specification into `passedSpecifications`. That inflated the spec-level pass rate returned by the CLI's `ids --json` output relative to the CLI's own text-mode output (both should read from the same validation, but text mode reads `report.summary` directly while `--json` goes through `summarize()`).

`IDSValidationSummary` gains a `notApplicableSpecifications` field so `passedSpecifications + failedSpecifications + notApplicableSpecifications === totalSpecifications` always holds, matching the validator's own accounting.
