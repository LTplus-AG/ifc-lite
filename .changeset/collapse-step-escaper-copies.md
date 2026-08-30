---
'@ifc-lite/data': minor
'@ifc-lite/export': patch
---

The STEP string escaper (`escapeStepString`) existed twice in TypeScript: once, private, in `@ifc-lite/data`'s `step-serializers.ts`, and again, exported, in `@ifc-lite/export`'s `step-serialization.ts`. The two bodies were identical — same backslash/quote doubling, same `\X2\`/`\X4\` non-ASCII directive thresholds, same one-space-per-control-character rule. `@ifc-lite/export` already depends on `@ifc-lite/data` with no cycle, so there was no reason for the second copy.

`@ifc-lite/data` now exports `escapeStepString` as the single implementation; `@ifc-lite/export`'s `step-serialization.ts` re-exports it instead of keeping its own copy, so every existing call site is unaffected. The Rust implementation, `ifc_lite_export::step_text::escape`, stays separate — sharing it with TypeScript would need a wasm adapter, which is a bigger change than this one — and continues to be pinned by a hand-kept vector test rather than shared code.

A prior fix (#3284) added a test in each of the two TypeScript files asserting that both matched the Rust half's output on the same inputs; with only one TypeScript implementation left, that duplication is gone and the coverage lives once, in `@ifc-lite/data`'s `step-serializers.test.ts`.
