---
'@ifc-lite/sdk': patch
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

Fix `bim.mutate.setProperty` silently accepting a write to an entity that is not in the model.

In the headless backends (`ifc-lite run`/`eval` and the MCP session), `setProperty` took the express id on faith. `MutablePropertyView` created an overlay property set for it, `bim.properties()`/`bim.property()` read that overlay back and reported the edit as made, and the STEP exporter — which only ever visits entities the store holds — dropped it with no diagnostic. A script with a stale or mistyped express id had no point in the round trip where the mistake showed up: the obvious defensive check, reading the property back, returned a confident "it worked".

`createHeadlessMutateAdapter` now takes an `entityExists` predicate (both backends pass the store's entity index) and `setProperty` throws when the id is not in the model, naming the express id and the model id. A script that only ever passes real express ids is unaffected.
