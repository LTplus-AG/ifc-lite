---
'@ifc-lite/sdk': major
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

Fix `bim.mutate.setProperty`/`setAttribute`/`deleteProperty` silently accepting a write to an entity that is not in the model.

In the headless backends (`ifc-lite run`/`eval` and the MCP session), the write methods took the express id on faith. `MutablePropertyView` created the overlay entry for it, `bim.properties()`/`bim.property()` read that overlay back and reported the edit as made, and the STEP exporter — which only ever visits entities the effective model holds — dropped it with no diagnostic. A script with a stale or mistyped express id had no point in the round trip where the mistake showed up: the obvious defensive check, reading the property back, returned a confident "it worked".

`createHeadlessMutateAdapter` now takes an `entityExists` predicate and every write method throws when the reference does not name an entity, naming the express id and the model id. The predicate is checked against the **effective** model — the source store plus this session's overlay — so an id handed back by `bim.store.addEntity` is accepted and a removed one is refused, and against the **model id** as well, because the write methods forward only the express id to the backend's single overlay and a foreign model id would otherwise land as an edit to the active model.

**Breaking (`@ifc-lite/sdk`):** `createHeadlessMutateAdapter` takes a second, required argument, `entityExists: EntityExistsPredicate`. The parameter is required rather than optional on purpose: a backend that forgot to pass it would otherwise go back to accepting phantom writes with nothing to say it had. A new export, `createEffectiveEntityExists({ acceptsModelId, hasSourceEntity, overlay })`, builds the predicate both headless backends use, so a host adapter does not have to rediscover that the base entity index is the wrong thing to ask.
