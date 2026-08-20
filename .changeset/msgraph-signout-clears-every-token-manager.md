---
"@ifc-lite/source-msgraph": patch
---

Fix `signOut()` resurrecting a signed-out session when a token refresh is already in flight.

`msGraphAuth.signOut` built one `TokenManager` from freshly-read `clientId`/`tenant` preferences and cleared only that instance. `TokenManager`'s refresh-race protections are all per-instance, so if either preference changed (or was cleared) between when the manager actually holding an in-flight refresh was created and when `signOut` ran, `signOut` would clear a *different* cached manager - leaving the real one's refresh free to write a valid token set back to storage right after sign-out deleted it. The user would appear signed out, then be silently signed back into the account they explicitly disconnected on the next mount.

`source-dropbox`'s `signOut` already guards this exact shape (`#2635`): it clears every cached `TokenManager`, not just the one the current preferences name. `source-msgraph` now does the same - `signOut()` iterates `managerCache.values()` and clears each one before resetting the cache.

`test/refresh-race.test.ts` gains a case reproducing the race (clientId cleared mid-flight, mirroring `source-dropbox/test/refresh-race.test.ts`'s scenario) and asserting storage stays clean after sign-out.
