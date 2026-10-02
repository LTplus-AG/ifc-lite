---
"@ifc-lite/collab-server": minor
"@ifc-lite/viewer": patch
---

A fresh-room claim whose room is never created no longer has to hold its slot in the claim allowance forever (#6581).

The new `claimsPendingUntilJoin` option of `createAccessControl` turns this on, and the CLI server sets it. With it, a first-touch claim stays pending until the room's first authenticated join through `serverOptions.authenticate`, and that join is admitted only once the confirmation is written to disk. A pending claim can be handed back with the new `POST /collab/release` route. The route needs an admin token minted for that claim, frees the slot and revokes every token minted for the claim. A pending claim that nobody releases expires once all of its tokens have expired. A room that was joined, or has a room log on disk, is never released or expired.

Bounds and checks that come with pending claims:

- Up to 4 tokens can be minted for a pending claim, and those mints pay the same per-IP budget as a fresh claim.
- A release is refused with 503 when it would take the deny-list past `maxRevocationsForRelease` live entries (default 1024). The claim is then kept and expires on its own.
- The token and release routes refuse room ids holding an unpaired UTF-16 surrogate.
- If the data-dir check for a room log cannot answer, the claim is treated as in use.

Without the option, every claim is permanent from its first mint (as before), claims an earlier run left pending are confirmed at load, and the release route answers 409.

New exports: `handleReleaseRequest`, `ReleaseEndpointOptions` and `ReleaseResult`. Also new: the `releaseEndpoint` option of `startCollabServer`, the `now`, `claimsPendingUntilJoin` and `maxRevocationsForRelease` options of `createAccessControl`, and a `mint` (`{ jti, exp }`) field in the token route's `authorize` context. `access-control.json` gains a `pendingClaims` field. Pending rooms are also kept in `claimedRooms`, so an older server reading the file treats them as claimed. A file written before this change loads every claim as confirmed.

The viewer's Share dialog releases the claim when creating the room fails after the admin token was minted, for example because the model's metadata became invalid during the token request or the session never came up. Against a server without the route, or one that refuses the release, nothing else changes.
