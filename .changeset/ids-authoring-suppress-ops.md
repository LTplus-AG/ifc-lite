---
"@ifc-lite/ids-authoring": minor
---

Lint suppressions can now be written through ops: `meta.suppress { nodeId, suppression, index? }` and `meta.unsuppress { nodeId, rule }` write the `meta.suppressions` entries the linter reads, and both undo exactly. The gate refuses an unknown node, a rule that is not a lint code or wildcard (`GATE-SUP-001`) and a blank reason (`GATE-SUP-002`). Removing a suppression that is not there is `GATE-SUP-003`. `IDSL-ENT-003` and `IDSL-SPEC-008` are now opt-in (`LintRuleMeta.optIn`): they are off by default and run when the linter config gives them a severity or names them in `rules`.
