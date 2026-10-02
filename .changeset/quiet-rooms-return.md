---
"@ifc-lite/collab-server": minor
"@ifc-lite/viewer": patch
---

A fresh-room claim whose room is never created no longer holds its slot in the claim allowance forever (#6581). `createAccessControl` now keeps a first-touch claim pending until the room's first authenticated join, and admits that join only once the confirmation is written to disk. A pending claim can be handed back with the new `POST /collab/release` route. The route needs an admin token minted for that claim, frees the slot and revokes every token minted for the claim. A pending claim that nobody releases expires once all of its tokens have expired. A room that was joined, or has a room log on disk, is never released or expired. Up to 8 tokens can be minted for a pending claim; further mints are refused until the room is joined.

New exports: `handleReleaseRequest`, `ReleaseEndpointOptions` and `ReleaseResult`. Also new: the `releaseEndpoint` option of `startCollabServer`, the `now` option of `createAccessControl`, and a `mint` (`{ jti, exp }`) field in the token route's `authorize` context. `access-control.json` gains a `pendingClaims` field. Pending rooms are also kept in `claimedRooms`, so an older server reading the file treats them as claimed. A file written before this change loads every claim as confirmed.

The viewer's Share dialog releases the claim when creating the room fails after the admin token was minted, for example because the model's metadata became invalid during the token request or the session never came up. Against a server without the route, the release gets a 404 and nothing else changes.
