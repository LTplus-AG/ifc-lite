---
'@ifc-lite/sdk': major
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

Fix `bim.mutate.setProperty`/`setAttribute`/`deleteProperty` silently accepting a write to an entity that is not in the model.

In the headless backends (`ifc-lite run`/`eval` and the MCP session), the write methods took the express id on faith. `MutablePropertyView` created the overlay entry for it, `bim.properties()`/`bim.property()` read that overlay back and reported the edit as made, and the STEP exporter — which only ever visits entities the effective model holds — dropped it with no diagnostic. A script with a stale or mistyped express id had no point in the round trip where the mistake showed up: the obvious defensive check, reading the property back, returned a confident "it worked".

`createHeadlessMutateAdapter` now takes an `EntityRefCheck` and every write method throws when the reference does not name an entity. The check runs against the **effective** model (the source store plus this session's overlay), so an id handed back by `bim.store.addEntity` is accepted and a removed one is refused, and against the **model id** as well, because the write methods forward only the express id to the backend's single overlay and a foreign model id would otherwise land as an edit to the active model. The two are reported as different failures: a missing entity names the express id and the model, an unknown model id says so and lists the ids the backend does answer for, because in that case the entity usually exists and calling it missing sends the caller after the wrong problem.

The MCP mutation tools (`entity_set_property`, `entity_delete_property`, `entity_set_attribute`, and `mutation_batch` through them) do not go through `bim.mutate.*` (they write into the backend's mutation view directly), so they took `express_id` on faith and answered "Queued" for an id the export then dropped. They now run the same check first and return an `ENTITY_NOT_FOUND` result naming the express id and the model. `entity_create` has no id to check yet and `entity_delete` already reports whether it removed anything, so neither is routed through it.

`bim.store.addEntity` and the `bim.store.add*` element helpers now refuse an unknown model id too, instead of echoing it back on the ref they mint. A ref accepted by the creator and refused by the very next write is worse than either rule alone, since the entity is already created by the time the caller finds out.

**Breaking (`@ifc-lite/sdk`):** `createHeadlessMutateAdapter` takes a second, required argument, `checkRef: EntityRefCheck` (a function returning `null` for a writable reference, or the reason it is not). The parameter is required rather than optional on purpose: a backend that forgot to pass it would otherwise go back to accepting phantom writes with nothing to say it had. A new export, `createEffectiveEntityCheck({ acceptedModelIds, hasSourceEntity, overlay })`, builds the check both headless backends use, so a host adapter does not have to rediscover that the base entity index is the wrong thing to ask.
