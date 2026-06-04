---
"@ifc-lite/lists": minor
---

Add `ListDataProvider.discoverAllColumns()` for complete, type-independent
column discovery.

Lets the list column picker offer every property set / property and quantity
set / quantity in the model — even when no entity type is selected — instead
of only the columns sampled from the selected types. Optional method; callers
fall back to the type-sampled `discoverColumns()` when it's absent.
