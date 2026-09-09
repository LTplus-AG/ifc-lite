---
"@ifc-lite/lists": patch
"@ifc-lite/viewer": patch
---

`compileNameMatcher` (the `/regex/` name-pattern compiler shared by list columns, the SDK's `property`/`quantity` query methods, and the sandbox's `bim.query.property` bridge tool) now rejects a pattern with a catastrophic-backtracking shape (`(...+)+`, `(...+)*`, `(.*)+`, `(.*)*`) or over 256 characters, throwing instead of compiling a live `RegExp` that could hang on `.test()`. This closes a ReDoS reachable from an LLM/agent-authored viewer sandbox script's own tool-call arguments, where the regex compiles and runs on the host's main thread outside the QuickJS sandbox.

The check is delegated to `@ifc-lite/regex-guard`'s `assertGuardedRegexPattern` (added for #4259's IDS `xs:pattern` and bulk-edit name-pattern guards) rather than a fourth hand-copied heuristic in this package.

This is a shape heuristic, not an exhaustive defence — it catches the textbook catastrophic forms, not every pattern a determined author could construct. A complete fix (a Worker + timeout, or `re2-wasm`) is future work.

The viewer's set-name pattern-builder preview (`pattern-preview.ts`) is updated to catch this rejection and surface it through the existing "Invalid pattern" warning instead of throwing mid-keystroke.
