---
"@ifc-lite/renderer": patch
---

Fix two `DeviationComputer` bugs in the BIM ↔ scan deviation compute path (`packages/renderer/src/deviation/deviation-computer.ts`):

- `init()` was not idempotent: calling it a second time without an intervening `destroy()` left the previous run's `bvhFingerprint` in place. The next `compute()` call with the same mesh set would then match that stale fingerprint, skip re-uploading the BVH into the new pipeline, and silently report zero chunks processed — a plausible-looking deviation of zero instead of a loud failure. `init()` now tears down any existing pipeline (releasing its GPU buffers) and resets the fingerprint before creating the new one.
- `releaseTransientParams()` — which frees the per-chunk uniform buffers from a `compute()` call — was skipped whenever `queue.onSubmittedWorkDone()` rejected (e.g. a lost GPU device mid-submit), leaking those buffers. The release now runs in a `finally` block so it executes on every exit path, including rejection.
