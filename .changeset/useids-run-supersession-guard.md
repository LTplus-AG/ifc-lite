---
"@ifc-lite/viewer": patch
---

Fix a slower IDS validation run overwriting a newer, faster one in the IDS panel.

`runValidation()` in `useIDS.ts` resolved its target model once, awaited the (potentially long, worker-or-main-thread) validation, and then wrote `setIdsValidationReport(...)` unconditionally - with no guard of any kind, not even a federation-identity check. Two validations issued back to back (a re-run, or a different target model picked from the federation dropdown while one was still running) raced: whichever finished last won the store, regardless of which the user actually issued last.

`runValidation()` now captures a per-call epoch and re-checks it immediately before every store write that follows an `await` - the progress updates, the published report, the caught-exception error, and the `finally` that flips `idsLoading` back off. The `finally` check matters as much as the report write: without it, an older call's `finally` running after a newer one has already started reports "not loading" while the newer validation is still genuinely in flight. `clearIDS()` and `clearValidation()` also bump the epoch, so a clear mid-run cannot be resurrected by the run it cleared landing afterwards.
