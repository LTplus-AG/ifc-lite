---
"@ifc-lite/viewer": patch
---

Fix the basket evicting isolation it did not own. `isolatedEntities` is shared by the basket, direct isolate, BCF viewpoint restore, lens and search; unpinning an element deleted its global id from that set even when another feature had isolated it independently, and emptying the basket by removal cleared every isolation channel. The basket now keeps a value-matched ownership record (`basketIsolationOwned`, the repo-wide `lib/visibility/ownership` convention): it claims only the ids it inserted, never narrows a channel another writer has since replaced, closes the channel on empty only when it opened it, and hands back the remainder otherwise. The unused legacy `addToPinboard` / `removeFromPinboard` / `setPinboard` / `isInPinboard` / `getPinboardCount` / `getPinboardEntities` actions are removed.
