---
"@ifc-lite/site-context": minor
"@ifc-lite/cli": minor
---

New `@ifc-lite/site-context`: swissALTI3D terrain and the cadastral parcel around a georeferenced Swiss site as one document in a local frame stated in EPSG:2056 / EPSG:5728 (`buildSiteContext`), written and read back exactly as a self-describing GLB (`encodeSiteContextGlb` / `decodeSiteContextGlb`), with attribution, issues and completeness per layer. New CLI command `ifc-lite site-context <model.ifc> --radius M --out context.glb [--json]` takes the centre from the model's map conversion (or `--centre E,N` / `--egrid CH…`), caches responses on disk and supports `--offline`. Every request goes through `swisstopoOnlyFetch` (also exported with `isAllowedSwisstopoUrl`, `SiteContextHostRefused` and `SWISSTOPO_HOSTS`): only swisstopo hosts, https, no redirects. A map unit that reads as metres is reported as assumed, because an unreadable `MapUnit` reads the same.
