---
"@ifc-lite/sandbox": minor
"@ifc-lite/clash": patch
---

Cancel clash detection when the script run that asked for it ends.

A sandbox run that exceeded `limits.timeoutMs`, or a sandbox disposed mid-run, stopped *waiting* for `bim.clash.run` / `bim.clash.matrix` but never stopped the engine: it kept intersecting geometry to completion in the background, on the user's machine, for a result that was discarded on arrival. The bridge now hands every call an `AbortSignal` and aborts it on both paths, and the clash namespace forwards it as `ClashSettings.signal`.

`@ifc-lite/sandbox` is a minor rather than a patch because `BridgeCallContext.hostSignal` is new capability surface for schema authors, reachable through the `@ifc-lite/sandbox/schema` subpath. Nothing was removed or renamed.

`ClashSettings.signal` also now works the way its name implies. The TypeScript engine checked it periodically but only yielded to the event loop when an `onProgress` callback was supplied — and every realistic canceller (a deadline timer, a cancel button, a host teardown) fires *from* the event loop, so without `onProgress` the flag could never flip mid-run. A caller that supplies a signal now gets the periodic yields too, the check runs every 256 candidate pairs rather than every 1024, and the signal is rechecked immediately after each yield, since the yield is the window the abort arrives in.

One bound is worth stating plainly: those handlers can only run during a yield, and the first yield comes after ~50 ms of held thread time, so a run that finishes inside that window completes rather than cancelling. Cancellation is for runs long enough to be worth cancelling.

No API changed shape: `ClashSettings.signal` already existed, and cancellation stays opt-in for direct engine callers.
