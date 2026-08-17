---
"@ifc-lite/viewer": patch
---

Fix "select elements in this zone" selecting nothing inside a collaborative room.

Zone selection resolved each matched element through the `federationRegistry`
singleton alone, and dropped every id the registry could not place. The collab
recipient seeds its room model with `upsertModel` and never calls
`registerModelOffset` (`collabSlice.ts`), so the registry knew none of the
room's ids: every match was dropped, and the panel then took its empty-result
branch and answered `No elements in this zone` — a confident, false statement
about the zone's contents rather than a silent no-op. Federated-IFCX
composition seeds its layers the same way.

Resolution now goes through the store's canonical `resolveGlobalIdFromModels`
— the resolver `resolveEntityRef.ts` calls the single source of truth, and the
only one that also sees overlay-allocated ids via its `mutationViews` pass —
falling back to the registry for a model that has left `state.models` but is
still registered. `useIfcFederation`'s `findModelForEntity` / `resolveGlobalId`
get the same delegation. Sibling of the clash-path fix in #2697.

This is complete only while the room's id space stays inside the first
snapshot's maximum. `collabSlice` computes the room model's `maxExpressId` in
its first-reconstruct branch only; every later peer edit goes through
`setIfcDataStore`, which replaces the store and leaves `maxExpressId` at the
first value. Ids allocated after that snapshot fall outside the model's
recorded range and still resolve to nothing — measured in review at 3 of 4
assigned elements once a peer adds one, and 0 of 3 when the first build saw an
empty doc and the bound froze at 0. That is a pre-existing `collabSlice`
defect, degrading every `resolveGlobalIdFromModels` consumer in a room rather
than zone selection specifically, and it is not fixed here.
