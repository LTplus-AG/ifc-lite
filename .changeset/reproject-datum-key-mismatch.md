---
"@ifc-lite/viewer": patch
---

Fix EPSG:2065 (S-JTSK Ferro Krovak) and EPSG:27700 (OSGB36 British National Grid, when its precision-grid fetch is unavailable) silently getting zero datum shift on reprojection.

`sanitizeProj4`'s `DATUM_TOWGS84` fallback table is keyed by the datum name reported by the bundled EPSG index (`packages/data`), lowercased. For EPSG:2065 that name is `"S-JTSK (Ferro)"`, and for EPSG:27700 it is `"OSGB36"` — neither matched the table's existing `'s-jtsk'` / `'osgb 1936'` keys, so the lookup missed silently (no warning either, since the OSGB36 case only warns when a `+nadgrids` reference is present to strip, and the 2065 def carries none). EPSG:2065 has no precision-grid coverage at all (see `precision-grids.ts`), so this fallback was its only datum shift — every EPSG:2065 model reprojected with the source CRS's raw coordinates read as if they were already WGS84, landing roughly 100+ m off. EPSG:27700 is normally rescued by the OSTN15 precision grid, so this only bit when that fetch failed (offline, CDN down, or in a Node test environment, which always skips the network fetch).

Added `'osgb36'` and `'s-jtsk (ferro)'` as additional keys carrying the same published Bursa-Wolf parameters already used under the existing aliases. `reproject.test.ts`'s EPSG:2065 fixture previously passed the idealized datum name `'S-JTSK'` rather than the real `'S-JTSK (Ferro)'` the bundled index reports for that code, which is why the mismatch went unnoticed — it now uses the real value, plus a new OSGB36 case.
