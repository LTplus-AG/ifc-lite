---
"@ifc-lite/viewer": patch
---

Fix a superseded model comparison overwriting a newer one in the Compare panel.

`isCurrentFor` / `buildAtCurrentVersion` in `useCompare.ts` guard the fingerprint cache against a federation re-alignment moving meshes in place — they say nothing about whether a given `runComparison()` call is still the one the user is waiting on. Three ways an in-flight comparison could clobber the panel after the fact, all now fixed:

- A slower `runComparison()` call finishing after a newer one (a different A/B pair, or a re-run) published its answer over it.
- `clearCompare()` mid-flight did not stick: the in-flight run's eventual result or error resurrected what the user had just cleared.
- Changing the A/B selection mid-flight (without clicking Run again) still published a result for the old pair, which nothing checked against the currently selected pair — the panel could show a diff that didn't match its own selectors.

`runComparison` now captures a per-call epoch and re-checks it, together with the live `compareBaseModelId`/`compareHeadModelId`, immediately before every write to the store (success, the exhausted-retries error, and the failure path) — never earlier, so nothing can supersede between the check and the write. `clearCompare` is now returned from `useCompare()` and bumps that epoch before delegating to the store action, so `ComparePanel` (and the hook's own re-alignment cleanup) route through it instead of calling the raw store action directly.
