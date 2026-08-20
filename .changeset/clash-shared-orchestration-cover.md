---
"@ifc-lite/clash": patch
---

Add direct tests for `runClash`'s shared orchestration (severity resolution, exclusions, dedup, sort ordering, summary tallies) and document a blind spot in `differential.test.ts` (#2830).

`engine-wasm/index.ts` calls the same `runClash` (`engine-ts/orchestrator.ts`) as `engine-ts/index.ts`, so the differential suite comparing the two backends can never catch a bug in that shared orchestration — only in the geometry kernel. Verified: constant-folding `inferClashSeverity` to always return `'info'` left all 16 differential tests passing.

The suite's header now says so explicitly. `engine-ts/orchestrator.test.ts` (new) drives `runClash` directly through a fake kernel to cover severity resolution, exclusion gating, identity/dedup, and sort ordering on their own terms; `analysis.test.ts` gained direct coverage of `summarizeClashes`'s tallies. No behavior changes — tests only.
