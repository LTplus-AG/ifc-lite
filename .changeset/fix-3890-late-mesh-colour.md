---
"ifc-lite": patch
---

fix(viewer): colouring an assembly now reaches parts whose meshes stream in later (#3890)

Hide and isolate are whitelists the renderer re-matches mesh ids against, so a part that streams in after the action is caught the moment its mesh lands. Colour was not: `pendingColorUpdates` is a one-shot signal that is flushed and nulled, and `scene.setColorOverrides` builds overlay batches once from `meshDataMap`, so a part with no mesh at flush time was never painted at all.

The colour channel now hands the scene back its own retained override map once the geometry counter settles and the mesh queue has drained, which rebuilds the overlay batches with the late meshes included. It does that only when an override id it was waiting on has actually arrived, so an active overlay does not pay a rebuild after every later streaming burst, and it costs nothing when nothing is coloured. Because the map is read from the scene at that moment rather than remembered, a targeted `resetColors` is not repainted and a correction made in the meantime is the colour that lands.
