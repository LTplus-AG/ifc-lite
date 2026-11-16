# @ifc-lite/tiles3d

## 0.2.0

### Minor Changes

- [#10404](https://github.com/LTplus-AG/ifc-lite/pull/10404) [`cec09a0`](https://github.com/LTplus-AG/ifc-lite/commit/cec09a0d99e5c098b6c8cb07f3fe10aad9945758) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/tiles3d`, a headless OGC 3D Tiles reader. `readTilesetRegion` traverses a tileset for a WGS84 region and follows external tilesets, recognised by their content. It culls `region`, `box` and `sphere` volumes through tile transform chains, and applies `ADD` or `REPLACE` refinement. Contents are b3dm or glb, with Draco through a lazily loaded, shared `draco3d` decoder whose wasm the package exports as `@ifc-lite/tiles3d/draco_decoder.wasm` for browser bundles. Each feature comes back as a float64 mesh in the tileset frame, with primitive groups, batch table attributes and tile provenance. Request, streamed byte and decoded vertex/index budgets truncate explicitly; every count a file declares is validated before allocation; failures and refusals are typed issues, and partial results are kept. A default URL policy fetches only `http(s)` on the root tileset's origin. `ecefToGeodetic` and `geodeticToEcef` convert positions. A `readSwisstopoBuildings` preset covers swisstopo's buildings tileset and flags tiles without building ids or height columns.
