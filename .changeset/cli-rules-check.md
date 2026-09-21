---
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

CLI/MCP parity for `.rules.json` information-validation rule sets (#5138 PR 7b), running the same `@ifc-lite/rules` engine (`runRuleSet`) the viewer's Data Validation panel runs — no second evaluator, no parity fixture. New `ifc-lite check <model.ifc>... --rules <file.rules.json> [--format json|table] [--fail-on error|warning]`, exit `0` all pass / `1` any fail / `2` any rule error or unreadable input. `ifc-lite delivery` recipes gain an additive `rules: string[]` field (tri-state `pass`/`fail`/`error`, mirroring `ids`). New MCP tool `check_rules` wraps the same engine against every model in scope.
