---
'@ifc-lite/parser': minor
---

`extractAllMaterialsOnDemand` now consults the relationship graph before it gives up on a store without source bytes, such as a server-parsed model (#5227). The classification resolver already did this for #3948. When the graph proves a material association, it returns one `{ type: 'Material', unresolved: true }` marker per association instead of `[]`, so callers can tell "has a material this store cannot read" apart from "no material". `MaterialInfo` gains the optional `unresolved` flag.
