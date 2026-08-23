---
"@ifc-lite/viewer": patch
---

Report openings a wall split could not reassign on the typed-distance path too, not only the click path.

A wall split commits from two places, and both call the same `MutationSlice.splitWallAtDistance`, so both receive the same `openings.skipped` count — openings that stay attached to the source wall the split has just tombstoned rather than moving to either half, and can therefore end up orphaned. #3023 taught only the canvas click handler (`selectionHandlers.ts`) to surface that count. The Split tool's numeric-distance panel (`tools/SplitNumericInput.tsx`) kept its own inlined copy of the "(N openings reassigned)" wording, read only `toLeft`/`toRight`, and never looked at `skipped` at all — so committing the identical split by typing a distance instead of clicking silently dropped the warning that clicking showed.

Both notices now come from a single emitter, `notifyWallSplit` in the new `wallSplitNotice.ts`, which both call sites invoke instead of composing toasts themselves. An emitter rather than a shared formatter is the point: a formatter is still something a call site can neglect to call, which is exactly how these two paths came apart. The module imports nothing but the toast surface, so announcing a split does not drag `selectionHandlers.ts`'s store, geometry and measurement imports into the panel. Both paths are now pinned by tests asserting the full toast strings, in both directions — the warning when `skipped > 0`, and silence when it is 0.
