---
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/cache": minor
---

CLI/MCP parity for `.rules.json` information-validation rule sets (#5138 PR 7b), running the same `@ifc-lite/rules` engine (`runRuleSet`) the viewer's Data Validation panel runs — no second evaluator, no parity fixture. New `ifc-lite check <model.ifc>... --rules <file.rules.json> [--format json|table] [--fail-on error|warning]`, exit `0` all pass / `1` any fail / `2` any rule error or unreadable input. `ifc-lite delivery` recipes gain an additive `rules: string[]` field (tri-state `pass`/`fail`/`error`, mirroring `ids`). New MCP tool `check_rules` wraps the same engine against every model in scope.

`@ifc-lite/cache` gains `computeSourceFingerprint`/`computeSourceFingerprintFromBlob` (moved from the viewer's `hooks/sourceFingerprint.ts`, review finding on #5171): a rule set's `targets.modelFingerprints` is saved from the viewer's `FederatedModel.sourceFingerprint`, so a headless caller (the CLI, the MCP server) needs the SAME spread-sampled xxhash64 to resolve it — a SHA-256 of the full bytes, what `ifc-lite check`/`delivery` used before this fix, can never match it. `@ifc-lite/viewer` is a private, unpublished app and gets no changeset entry of its own — its import of this code moved from a local hook to `@ifc-lite/cache`, an internal refactor with no published-API surface of its own.
