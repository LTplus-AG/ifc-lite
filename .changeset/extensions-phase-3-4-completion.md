---
"@ifc-lite/extensions": minor
---

Phase 3 + 4 completion — flavor switcher, test runner, SDK
revalidation, memory extractor, miner integration.

Library additions across this batch:

- **Test runner** (`testing/runner.ts`, `testing/synthetic.ts`):
  `runBundleTests` drives a bundle's declared `manifest.tests` against
  the existing `ExtensionRuntime`. Matchers: mimeType / byte range /
  regex / jsonShape. Synthetic fixtures provide a content-free
  `bim` ctx with `query.byType` + `query.count` so tests can run
  without real IFC files. Canonical residential-small /
  office-medium / empty-model included.
- **Dry-run profile** (`dryrun/profile.ts`): RFC §02.5 budgets
  (25 % memory, 50 % CPU of production) for the authoring loop's
  transient runtime.
- **SDK version + revalidation** (`host/sdk-version.ts`,
  `host/sdk-revalidate.ts`): hand-rolled semver-lite matcher and the
  revalidate orchestrator that re-runs manifest tests for every
  installed extension whose engine range no longer matches the
  candidate SDK.
- **Flavor switcher** (`flavor/switcher.ts`): three-step
  enable/disable/load orchestration with full rollback on any failure
  (deactivate throw, reload returning false, pointer-write failure).
- **Memory extractor** (`flavor/memory-extractor.ts`): rule-based
  preference scanner over chat transcripts with a strict content
  blocklist (GUIDs, paths, emails, API keys). `mergeIntoOverlay`
  seeds a Preferences section and deduplicates.
- **Eval suite** (`eval/loops.test.ts`): end-to-end coverage of the
  three §06 loops — planted-pattern miner, memory-extractor leak
  prevention, SDK-update flagging.

Test count: 558 across 49 files, all passing.
