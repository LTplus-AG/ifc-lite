---
"@ifc-lite/pointcloud": minor
"@ifc-lite/ifcx": patch
---

`@ifc-lite/pointcloud/ifcx` exports the IFCx point attribute decoders (`POINTCLOUD_ATTR`, `POINTCLOUD_ATTR_KEYS`, `decodeIfcxPointAttribute`, `decodeIfcxPointSource` and their types) without the streaming sources. `@ifc-lite/ifcx` now imports from it, so bundling `@ifc-lite/ifcx` (and `@ifc-lite/sdk`, which depends on it) with esbuild or wrangler no longer reaches the LAZ decoder's Vite-only `laz-perf/lib/web/laz-perf.wasm?url` import and no longer needs the package aliased to its attribute module.
