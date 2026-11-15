---
"@ifc-lite/viewer": minor
"@ifc-lite/geo": minor
---

Load site context in the viewer: for a model georeferenced in Switzerland, the Georeference panel's new "Site context" section fetches swissALTI3D terrain, the cadastral parcel and neighbouring swissBUILDINGS3D buildings (neutral grey massing, roofs darker, the model's own building hidden) straight from geo.admin.ch (only on click, through `@ifc-lite/site-context`'s swisstopo host allowlist, shared with the CLI, and an IndexedDB response cache) and loads each category as its own federated model, placed in the model's frame through the federation spatial reference, selectable, with its attributes in the properties panel (the parcel as `IfcSite` with `Pset_LandRegistration`). SWISSIMAGE can be draped on the terrain. Attribution shows in the viewport while any context model is visible and on each context model's card with every issue the data carries. A site-context GLB written by `ifc-lite site-context` and dropped on the viewer loads the same way.

Federation: an `IfcProjectedCRS` named by a well-known alias ("CH1903+ / LV95", "LV95", ...) now resolves to its EPSG code, marked as assumed from the name in the Georeference panel, and `LN02`/`LHN95` vertical datum names resolve to EPSG:5728/5729. Site context placed against a model that states no vertical datum takes its heights as LN02 and says so; one that states another datum is refused rather than mixed. A model whose map unit reads as metres is told metres are assumed, because an unreadable `MapUnit` reads the same.

`@ifc-lite/geo` exports `wellKnownCrsCode`, the name-alias lookup it already used internally.
