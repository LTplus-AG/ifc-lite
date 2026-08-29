---
'@ifc-lite/sandbox': patch
---

Fix `toRef()` accepting a `NaN`, `Infinity`, negative, or fractional `expressId`.

The bridge boundary shared by `bim.mutate`, `bim.store`, and `bim.query` checked `typeof ref.expressId === 'number'` but not that the number was a finite positive integer. `bridge-store.ts`'s `requireStoreyId` already enforced `Number.isInteger(id) && id > 0` for storey ids; `toRef` is now held to the same standard, since every call site trusts a non-null result as naming a real entity.

Concretely, this closes a silent-failure path: a script that computes an express id from parsed data (a CSV join is the documented use case) and passes a `NaN` or fractional value into `bim.mutate.setProperty`/`setAttribute`/`deleteProperty` used to record the mutation under a key no real entity has and no export path ever emits, with no exception — the script reported success while the edit went nowhere. `toRef` now returns `null` for these shapes. Of the 22 call sites, 5 throw `Error` on a `null` ref (the three in `bridge-mutate.ts` and the two in `bridge-store.ts`, e.g. `bim.mutate.setProperty: invalid entity reference`), so on those the behaviour changes from silent no-op to a thrown error. The other 17, all the read paths in `bridge-query.ts`, return an empty result on a `null` ref (`[]`, `null`, or an empty relationship object), so a bad express id there stops reaching the SDK and reads as "no data" instead.

This is an observable behaviour change: a script that was previously computing a bad express id and "succeeding" (the mutation was simply lost) will now throw from `bim.mutate`/`bim.store` instead, and get an empty result back from `bim.query`. A script that only ever passes valid express ids is unaffected.
