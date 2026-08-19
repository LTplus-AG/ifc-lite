---
"@ifc-lite/viewer": patch
---

Fix `removeModel`/`clearAllModels` leaving the pinboard/basket (`pinboardEntities`, `hierarchyBasketSelection`) pointing at a model that no longer exists.

`pinboardEntities` is pinboardSlice's documented source of truth for the basket: every basket edit (`addToBasket`/`removeFromBasket`/`showPinboard`) re-derives `isolatedEntities` from it via `toGlobalIdForRef` → `toGlobalIdFromModels`, which falls back to the raw, un-offset `expressId` once a ref's `modelId` is no longer in `models`. A basket ref surviving model removal therefore doesn't just dangle: the next basket operation can resolve it to a bare id that collides with a real entity in any surviving model whose own offset range covers that number (any model loaded at `idOffset` 0, notably), silently co-isolating or co-hiding an entity the user never touched — on top of inflating the basket's visible entity count in the toolbar/dock indefinitely. Same shape as the globalId-keyed selection/isolation state `removeModel` already purges (#2832); the basket's own `Set<string>` state was the one sibling that was missed. `clearAllModels` gets the matching unconditional clear for the full-teardown path.
