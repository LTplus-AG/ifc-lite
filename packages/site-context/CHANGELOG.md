# @ifc-lite/site-context

## 0.1.1

### Patch Changes

- Updated dependencies [[`40dd89f`](https://github.com/LTplus-AG/ifc-lite/commit/40dd89f534f021f5ebfa6dca0ede28274adf168a)]:
  - @ifc-lite/geo@0.2.0

## 0.1.0

### Minor Changes

- [#10480](https://github.com/LTplus-AG/ifc-lite/pull/10480) [`059dbfa`](https://github.com/LTplus-AG/ifc-lite/commit/059dbfaa246b52415b1a284b6ee282365207d7be) Thanks [@louistrue](https://github.com/louistrue)! - The site context's `buildings` layer: neighbouring swissBUILDINGS3D buildings around the site, read through `@ifc-lite/tiles3d`'s swisstopo preset (injectable `reader`, `fetch` and `cache` under the new `buildings` option), converted to the site frame, wound outward with flat normals, and split into `roof` and `wall` parts (`SiteContextMesh.parts`). Each building is an `IfcBuilding` feature with attributes in `IfcLite_SiteContextBuilding` (`BUILDING_SET`); the model's own building is marked `subject: true` by EGID or footprint overlap (`SUBJECT_MIN_OVERLAP`). Ids are unique (`building:egid:<EGID>`, with `:uuid:<UUID>` added where the tiles split one building into several objects), every object of the subject is marked and kept past the caps, and the height check covers the kept buildings only. Whole buildings touching the site are kept, capped with reported truncation. The GLB carries parts, the subject flag and layer provenance as optional format-1 extras, so older files still decode. `summarizeSiteContext` reports buildings. CLI: `--layers terrain,parcel,buildings`, `--subject-egid`, `--tile-requests`, a subject footprint from the model's element placements, an on-disk tile cache, and buildings in the JSON summary. The document states what H0 is (`originHeight`: the terrain height at the centre, or `null` with the reason when no terrain was read; H0 is then 0 as a frame offset), also in the GLB and the summary. The CLI's subject footprint for a model in another CRS (e.g. UTM) converts every corner to EPSG:2056 instead of adding offsets at the converted origin.

- [#10480](https://github.com/LTplus-AG/ifc-lite/pull/10480) [`059dbfa`](https://github.com/LTplus-AG/ifc-lite/commit/059dbfaa246b52415b1a284b6ee282365207d7be) Thanks [@louistrue](https://github.com/louistrue)! - New `@ifc-lite/site-context`: swissALTI3D terrain and the cadastral parcel around a georeferenced Swiss site as one document in a local frame stated in EPSG:2056 / EPSG:5728 (`buildSiteContext`), written and read back exactly as a self-describing GLB (`encodeSiteContextGlb` / `decodeSiteContextGlb`), with attribution, issues and completeness per layer. New CLI command `ifc-lite site-context <model.ifc> --radius M --out context.glb [--json]` takes the centre from the model's map conversion (or `--centre E,N` / `--egrid CH…`), caches responses on disk and supports `--offline`. Every request goes through `swisstopoOnlyFetch` (also exported with `isAllowedSwisstopoUrl`, `SiteContextHostRefused` and `SWISSTOPO_HOSTS`): only swisstopo hosts, https, no redirects. A map unit that reads as metres is reported as assumed, because an unreadable `MapUnit` reads the same.

### Patch Changes

- Updated dependencies [[`e15f582`](https://github.com/LTplus-AG/ifc-lite/commit/e15f5824cb0747471e0f2dc15c16ef47972fcb89), [`f78f7e0`](https://github.com/LTplus-AG/ifc-lite/commit/f78f7e0b7a346981030ad5a1d7b7c951fb0e1c27), [`cec09a0`](https://github.com/LTplus-AG/ifc-lite/commit/cec09a0d99e5c098b6c8cb07f3fe10aad9945758)]:
  - @ifc-lite/geo@0.1.0
  - @ifc-lite/geodata-ch@0.2.0
  - @ifc-lite/tiles3d@0.2.0
