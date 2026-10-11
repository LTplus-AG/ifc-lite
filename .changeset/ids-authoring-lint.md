---
"@ifc-lite/ids-authoring": minor
---

IDS lint engine: `createLinter` / `lintDocument` run a registry of rules over a `StudioDocument` and return `Diagnostic[]` with stable `IDSL-<AREA>-<nnn>` codes, a rationale and a per-rule docs URL. Spec-scoped findings are cached and re-run only for specifications that changed. Suppressions in `meta.suppressions` (with a reason) silence a rule on a node and everything below it. Quick fixes are op batches that pass the grounding gate (`checkQuickFix`); nothing is applied automatically.
