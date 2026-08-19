---
'@ifc-lite/collab-server': patch
---

Pin the path-lock accept path end to end: a write to an *unlocked* prefix, verified by `verifyAgainstPathLocks`, actually reaches a second peer through a real `startCollabServer` instance.

`path-locks.test.ts` already had a real reject-path test (`rejects writes to locked prefixes via verifyAgainstPathLocks`) but no accept-path equivalent — the remaining coverage was pure-function tests of `harvestUpdatePaths` / `registry.matches`. That asymmetry is exactly the shape that let the anti-replay protector's accept path go silently broken (fixed in #2846): `handleMessage` ignored the transformed `payload` the verifier returned, so every accepted edit vanished while the reject-path test stayed green.

`verifyAgainstPathLocks` doesn't transform its input (pure allow/deny), so it isn't exposed to that exact bug shape, but the accept path through `Room.dispatchMessage` was still unverified end to end. Confirmed the new test pins something: mutating `dispatchMessage`'s `MESSAGE_SYNC` branch to swallow accepted `messageYjsUpdate` frames without applying them fails only the new test (the reject-path test and the pure-function tests stay green); reverting restores 5/5.

No production code changed; this is coverage only.
