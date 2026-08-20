---
"@ifc-lite/viewer": patch
---

Fix a slower clash run overwriting a newer, faster one in the Clash panel.

`publishClashResult` in `useClash.ts` guarded every write to `clashResult` with a federation-identity check (`clashFederationIsCurrent`) - but that identity is keyed on the model set, not on which call started it. Two detection jobs issued while the federation is untouched (an "All elements" run, then a duplicate scan started while it is still going) carry the identical identity, so the guard could not tell a call the user is still waiting on from one they have moved past. An older, slower call finishing after a newer one had already published overwrote its answer.

`run()` and `runDuplicates()` now capture a per-call epoch and re-check it, together with the federation identity, immediately before every store write - the publish, the "no geometry loaded" error, the caught-exception error, and the `finally` that flips `clashRunning` / `clashProgress` back off. The `finally` check matters as much as the publish one: without it, an older call's `finally` running after a newer one has already started reports "not running" while the newer job is still genuinely in flight. `clearAll()` also bumps the epoch, so a clear mid-run cannot be resurrected by the run it cleared landing afterwards.
