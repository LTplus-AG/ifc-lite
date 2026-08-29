---
'@ifc-lite/viewer': patch
---

Make the store teardown seam fail to compile when a slice omits a scope arm, instead of silently no-oping.

`TeardownScope` is a three-kind union, and each of the 28 slice contributions was one `(scope, state)` function. 22 of them opened with `if (scope.kind !== 'session-reset') return {};`, which is exactly as "correct" for a scope kind that does not exist yet as for one that does — a fourth kind would have compiled clean, passed every test, and silently left those 22 slices' state uncleared.

Each contribution now declares one named arm per scope kind (`'session-reset'`, `'model-removed'`, `'all-models-cleared'`) via `defineSliceTeardown`'s new `SliceTeardownArms` record. Omitting an arm — today, or for a kind added to `TeardownScope` later — is a compile error in all 28 files at once, not a `{}` nobody wrote. `notApplicable` spells the deliberate "this scope does not touch me" case.

One trade-off, measured: typing every arm with the existing foreign-key rejection (a slice returning a key it does not own) tripled the checker's `Exclude<keyof ViewerState, K>` work across the 28-entry registry and crossed TypeScript's TS2590 ("union type too complex") budget. Arms are typed loosely instead, and `composeTeardown` now checks a returned key's ownership at runtime against the same map `createTeardownRegistry` already proves disjoint — a real check, just no longer a compile-time one for that specific case.
