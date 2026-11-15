---
"@ifc-lite/geodata-ch": minor
---

New package `@ifc-lite/geodata-ch`: a typed, headless client for Swiss federal geodata as site context in LV95 (EPSG:2056). It covers address search and parcels by EGRID or point. Terrain comes as swissALTI3D elevation grids read from the Cloud Optimized GeoTIFF tiles by range request, with the tile mosaic and overviews handled and heights in LN02 (EPSG:5728). It also offers swissBUILDINGS3D 3.0 tile discovery, swissTLM3D and register features in a box or polygon (cell splitting past the 200-feature cap), ÖREB extract URLs, and WMTS/WMS layer descriptors. Each result carries the dataset's required attribution. `fetch` is injectable, and the client has a cache hook, per-host rate limiting and retries with backoff. The provider contracts are country-neutral; only Switzerland is implemented.
