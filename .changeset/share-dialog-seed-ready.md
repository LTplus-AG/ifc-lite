---
"@ifc-lite/viewer": patch
---

Fix the Share dialog handing out an invite before the model was actually in the room (#4446). `startCollab` publishes `collabRoomId` synchronously and the provider reports `connected` long before the owner's structure and geometry uploads finish, and the dialog minted the link off the room id alone — so a guest (or the owner navigating to their own link) could open an empty room.

The initial seed is now explicit state, separate from connectivity: `collabSeedPhase` (`none | syncing | structure | geometry | ready | partial | failed`) with `collabSeedProgress` for the geometry blob count. The Share dialog shows an upload-progress row and keeps Copy disabled until the phase settles; a partial or failed seed still gets a link, but only alongside the existing incomplete-transfer alert. The room panel says "Uploading model" (with progress) instead of "Live" while the seed is in flight, disables its own copy-link button, and relabels Leave as abandoning the upload. Recipients never seed, so nothing changes for them.
