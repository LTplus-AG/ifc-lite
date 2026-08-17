---
"@ifc-lite/viewer": patch
---

Fix "select elements in this zone" selecting nothing inside a collaborative room.

Zone selection resolved each matched element through the `federationRegistry`
singleton alone, and dropped every id the registry could not place. The collab
recipient seeds its room model with `upsertModel` and never calls
`registerModelOffset` (`collabSlice.ts`), so the registry knew none of the
room's ids: every match was dropped and the command was a silent no-op that
still reported success. Federated-IFCX composition seeds its layers the same
way.

Resolution now goes through the store's canonical `resolveGlobalIdFromModels`
— the resolver `resolveEntityRef.ts` calls the single source of truth, and the
only one that also sees overlay-allocated ids via its `mutationViews` pass —
falling back to the registry for a model that has left `state.models` but is
still registered. `useIfcFederation`'s `findModelForEntity` / `resolveGlobalId`
get the same delegation. Sibling of the clash-path fix in #2697.
