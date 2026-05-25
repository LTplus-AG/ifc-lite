---
"@ifc-lite/extensions": minor
---

Phase 2 authoring pipeline — parsing, repair loop, diagnostics.

Closes 5 more plan tasks (P2.T8, T9, T10, T16, T17). The chat-side
authoring loop now has every library piece it needs to drive the LLM
through plan → bundle → validate → repair → install.

- **`authoring/synthesize.ts`** (T8/T9/T10) — `parseBundleOutput`
  extracts fenced `ifc-extension-manifest` / `ifc-extension-code` /
  `ifc-extension-widget` blocks from a chat response into a
  structured bundle. Manifest + widget JSON parsed; code stays as
  text. Surfaces structured errors on missing path attributes,
  duplicate manifest blocks, code-without-manifest. Bug found during
  development: the original regex used `\s+` for the attribute
  separator which greedily ate the JSON via `\n` matching as
  whitespace — fixed to `[ \t]+`, reproducer in tests.

- **`authoring/repair.ts`** (T16) — `runRepairLoop` drives the
  authoring loop: calls the LLM `AuthoringStep`, validates the
  response (manifest + widgets + code + cross-references +
  capabilities), feeds structured diagnostics back as a user turn,
  retries up to `maxAttempts` within `totalBudgetMs`. Per-attempt
  wall-clock budget enforced via promise race. Defensive copies of
  the conversation passed to the step so callers can't mutate the
  internal buffer.

- **`authoring/repair.ts:validateBundleResponse`** — single-pass
  validation: manifest → widgets → code → cross-reference. Used by
  both the repair loop and by callers that just want to validate an
  output without retrying.

- **`authoring/diagnostics.ts`** (T17) — `groupDiagnostics` /
  `renderDiagnostics` / `summariseDiagnostics`. Groups errors by
  leading scope (handles both JSON paths and file paths
  correctly), renders markdown-ish blocks for the chat UI, produces
  short summaries for toasts / headers.

Tests: 504 (up from 482 / +22). New test files: `synthesize.test.ts`,
`repair.test.ts`, `diagnostics.test.ts`. Two real bugs caught by
tests during development — the fence-regex greedy-eat and the
diagnostic scope leading-segment split.
