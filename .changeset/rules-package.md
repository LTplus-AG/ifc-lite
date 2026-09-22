---
"@ifc-lite/rules": minor
---

New package: the filter-rule vocabulary, the Path-B rule evaluator, and the `.rules.json` information-validation engine (`runRuleSet`), extracted from the viewer's Advanced Filter / Data Validation panel (#5138 PR 7a) so `packages/cli` can run the identical evaluator against the same rule sets. No React, no store, no DOM.

`@ifc-lite/viewer` is a private, unpublished app and gets no changeset entry — its import paths for this code moved from `lib/search`/`lib/validation` to `@ifc-lite/rules`, but that is an internal refactor with no published-API surface of its own.
