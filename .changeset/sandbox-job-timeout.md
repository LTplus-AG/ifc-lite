---
"@ifc-lite/sandbox": patch
---

Report a sandbox CPU timeout that hits an `async` script body instead of returning a stale value.

QuickJS surfaces an interrupted top-level body as an eval error, so a script that spins in its main body already failed with `interrupted`. But an `async` function body runs as a promise job, and `executePendingJobs()` reports no error when the CPU deadline cuts one short — so `eval()` returned the value the main body had produced before the job ran and reported success. A script whose real work happened inside `async function run()` could therefore time out and still look like it had completed.

The sandbox now records whether its interrupt handler actually fired and, after draining the job queue, raises the same `ScriptError: interrupted` the main-body path already raises. Scripts whose jobs complete normally are unaffected and still return the main-body value.
