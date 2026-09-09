---
"@ifc-lite/mutations": patch
"@ifc-lite/viewer": patch
---

`BulkQueryEngine.select()` compiled `criteria.namePattern` into a live `RegExp` and ran `.test()` on it once per candidate entity, with no complexity guard — reachable from the shipped viewer "Name Pattern (Regex)" field in the Bulk Property Editor (Author ribbon tab / main toolbar), not just a hypothetical programmatic caller as an earlier pass concluded. A catastrophic-backtracking pattern (e.g. `(a+)+$`) hangs the tab for seconds per matching name, and since this path scopes a bulk property edit, an unguarded regex also gates which entities get mutated. `select()` now throws before compiling when the pattern has a catastrophic-backtracking shape or exceeds 256 characters (`unsafeNamePatternReason` / `assertSafeNamePattern` in the new `packages/mutations/src/name-pattern-guard.ts`).

The Bulk Property Editor checks the pattern on every keystroke and shows a visible "Pattern rejected: …" message next to the field instead of letting the throw be swallowed by the existing try/catch (which previously logged a console warning and showed a silent "0 matches"), withholds a rejected pattern from the query criteria so it cannot silently fall back to matching the remaining criteria alone, and keeps Execute disabled.

This is the fourth copy of the same shape heuristic in the codebase (`packages/extensions/src/testing/runner.ts`, `packages/ids/src/constraints/xsd-regex.ts`, `packages/lists/src/name-pattern.ts`) — `packages/mutations` has no dependency edge on `@ifc-lite/lists` or `@ifc-lite/ids` to share one, and this environment cannot add a workspace edge. Extracting all four into one shared internal module is overdue; this duplicate is further evidence, not a new argument. Like its siblings, it is a shape heuristic (`(...+)+` / `(...+)*` / `(.*)+` / `(.*)*`), not an exhaustive defence — a complete fix (a Worker + timeout, or `re2-wasm`) is future work.
