---
"@ifc-lite/create": minor
"@ifc-lite/cli": patch
"@ifc-lite/sdk": patch
"@ifc-lite/sandbox": patch
---

Join coincident wall-chain endpoints automatically, carry grid-bound products when their grid moves, and enable native edge alignment in the headless CLI.

Keep implicit wall joins best-effort: refused joins leave the wall added and report notices on the returned SDK entity reference. Explicit joins still refuse atomically.

Discover implicit wall joins through a session endpoint index rather than rereading every wall for each addition. Commit index additions with their owning SDK/viewer transaction and invalidate on other model edits.
