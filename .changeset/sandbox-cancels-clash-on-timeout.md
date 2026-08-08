---
"@ifc-lite/sandbox": patch
"@ifc-lite/clash": patch
---

Cancel clash detection when the script run that asked for it ends.

A sandbox run that exceeded `limits.timeoutMs`, or a sandbox disposed mid-run, stopped *waiting* for `bim.clash.run` / `bim.clash.matrix` but never stopped the engine: it kept intersecting geometry to completion in the background, on the user's machine, for a result that was discarded on arrival. The bridge now hands every call an `AbortSignal` and aborts it on both paths, and the clash namespace forwards it as `ClashSettings.signal`.

`ClashSettings.signal` also now works the way its name implies. The TypeScript engine checked it periodically but only yielded to the event loop when an `onProgress` callback was supplied — and every realistic canceller (a deadline timer, a cancel button, a host teardown) fires *from* the event loop, so without `onProgress` the flag could never flip mid-run. Measured on a 426 ms run, a 200 ms abort timer stopped nothing at all; it now stops the run. A caller that supplies a signal gets the periodic yields too, and the cancellation check runs every 256 candidate pairs rather than every 1024, so a cancelled run stops sooner.

No API changed shape: `ClashSettings.signal` already existed, and cancellation stays opt-in for direct engine callers.
