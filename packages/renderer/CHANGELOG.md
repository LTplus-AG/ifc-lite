# @ifc-lite/renderer

## 1.15.3

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 1.15.2

### Patch Changes

- [#531](https://github.com/louistrue/ifc-lite/pull/531) [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e) Thanks [@louistrue](https://github.com/louistrue)! - Fix WGSL shader compilation failure on some GPUs and improve Chrome streaming performance

  - Move dpdx/dpdy calls outside non-uniform control flow to fix shader validation errors on Chrome/Windows GPUs (e.g. RTX 4070)
  - Use mappedAtCreation for vertex/index buffer uploads, eliminating redundant writeBuffer IPC round-trips on Chrome's Dawn backend
  - Increase streaming chunk size from 128 to 512 meshes per append to reduce GPU buffer allocation rounds
  - Remove noisy FederationRegistry "Unknown model" console warnings during single-model loading

- Updated dependencies [[`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b)]:
  - @ifc-lite/geometry@1.16.5
  - @ifc-lite/wasm@1.16.4

## 1.15.1

### Patch Changes

- [#526](https://github.com/louistrue/ifc-lite/pull/526) [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e) Thanks [@louistrue](https://github.com/louistrue)! - Fix robust flat normal computation, per-entity raycast and selection highlighting for color-merged meshes, and restore desktop native interaction parity.

- Updated dependencies [[`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc), [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e), [`cb59771`](https://github.com/louistrue/ifc-lite/commit/cb59771997e3837a511f584842bce98cd710864e), [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc), [`e8f3dfd`](https://github.com/louistrue/ifc-lite/commit/e8f3dfdc76871ef956701b0d176a9f197929d4dc)]:
  - @ifc-lite/geometry@1.16.4
  - @ifc-lite/wasm@1.16.3

## 1.15.0

### Minor Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Add CesiumJS 3D Tiles integration with synchronized camera controls, and expose renderer camera state for external consumers.

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Fix tile rendering issues in camera controls and projection handling.

- Updated dependencies [[`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162), [`05fd49f`](https://github.com/louistrue/ifc-lite/commit/05fd49f3fded214c5c5f59c61b0b55fcb7457f7b)]:
  - @ifc-lite/geometry@1.16.3
  - @ifc-lite/wasm@1.16.2

## 1.14.9

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix partial batch cache key collision by using unique batch id instead of expressIds

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix diagonal line artifacts on coplanar entity boundaries in separation lines shader

## 1.14.8

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`7a1aeb7`](https://github.com/louistrue/ifc-lite/commit/7a1aeb7fabdb4b9692d02186fe4254fc561bece4), [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/wasm@1.16.1
  - @ifc-lite/geometry@1.16.2
  - @ifc-lite/spatial@1.14.5

## 1.14.7

### Patch Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Fix I-beam profile shading with corrected circular profile detection threshold, two-sided lighting, and winding reversal for mirrored profiles

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/wasm@1.16.0
  - @ifc-lite/geometry@1.16.0

## 1.14.6

### Patch Changes

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix camera pan direction to match intuitive mouse movement.

- [#411](https://github.com/louistrue/ifc-lite/pull/411) [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515) Thanks [@louistrue](https://github.com/louistrue)! - Fix large model loading with streaming columnar parser, inline scan worker, and improved geometry bridge. Refactor relationship graph for better memory efficiency and add spatial index builder utilities.

- Updated dependencies [[`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515), [`f0da00c`](https://github.com/louistrue/ifc-lite/commit/f0da00c162f2713ed9144691d52c75a21faa18dd), [`af1ef14`](https://github.com/louistrue/ifc-lite/commit/af1ef1422d41fb4f7bb7f63720cca96ef7fe5515)]:
  - @ifc-lite/geometry@1.14.4
  - @ifc-lite/spatial@1.14.4
  - @ifc-lite/wasm@1.14.5

## 1.14.5

### Patch Changes

- [#402](https://github.com/louistrue/ifc-lite/pull/402) [`48af93b`](https://github.com/louistrue/ifc-lite/commit/48af93b30b08fefb24997edf26c0898d9beb2d1d) Thanks [@louistrue](https://github.com/louistrue)! - Fix external pivot orbit: use Rodrigues axis-angle rotation (Blender-style turntable) instead of independent spherical-coord clamping. Fixes inverted vertical direction, getting stuck at poles, and model flip when look direction approaches vertical. Adds clampLookVertical to prevent view matrix degeneracy while still allowing views from 89.4° above or below.

- [#396](https://github.com/louistrue/ifc-lite/pull/396) [`de2e949`](https://github.com/louistrue/ifc-lite/commit/de2e9495eb6d10ff247381d56a6991572f39f3cc) Thanks [@louistrue](https://github.com/louistrue)! - Remove all zoom restrictions and implement dolly-zoom for unrestricted scene traversal. Zoom now splits each step between distance reduction and forward travel, preventing the Zeno's paradox effect where the camera asymptotically approaches the target but never passes it. Refactor camera-controls to extract vec3/spherical helpers, eliminate duplicated orbit math, and use named constants.

- [#396](https://github.com/louistrue/ifc-lite/pull/396) [`de2e949`](https://github.com/louistrue/ifc-lite/commit/de2e9495eb6d10ff247381d56a6991572f39f3cc) Thanks [@louistrue](https://github.com/louistrue)! - Orbit now pivots around the 3D point under the cursor. At the start of every orbit drag (mouse or touch), a raycast determines what the user is looking at and uses that as the rotation center. If the cursor is over empty space, falls back to the camera target. Removes the old selection-based orbit center which was less intuitive.

- [#396](https://github.com/louistrue/ifc-lite/pull/396) [`de2e949`](https://github.com/louistrue/ifc-lite/commit/de2e9495eb6d10ff247381d56a6991572f39f3cc) Thanks [@louistrue](https://github.com/louistrue)! - Rework walk mode: arrow keys and WASD now move on a fixed horizontal plane with scene-proportional speed and smooth acceleration (velocity lerping). Shift-to-sprint doubles movement speed. Mouse drag in walk mode does full orbit (look around) instead of partial orbit + zoom. Remove orbit and pan tools from toolbar — orbit is the default mouse behavior and pan is accessible via middle/right-click.

## 1.14.4

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/wasm@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/spatial@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: prevent 3D background turning black when toggling spaces/openings/site visibility

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: eliminate facade flickering during orbit and zoom

  - Restore object-ID pass and post-processing during camera interaction (reverts interaction skip that caused visual pop-in)
  - Add PLANE_EPSILON margin to frustum culling plane checks to prevent floating-point jitter from toggling batch visibility at frustum boundaries
  - Skip fresnel glass effects on selected objects so blue highlight renders correctly instead of appearing white

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - fix: eliminate z-fighting flicker on coplanar faces

  - Upgrade depth buffer from depth24plus to depth32float across all pipelines for optimal precision with reverse-Z
  - Add per-entity deterministic depth nudge in vertex shaders using Knuth multiplicative hash to prevent coplanar face flicker
  - Refactor depthFormat into InstancedRenderPipeline member to eliminate hardcoded literals

- [#290](https://github.com/louistrue/ifc-lite/pull/290) [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0) Thanks [@louistrue](https://github.com/louistrue)! - perf: optimize rendering with buffer pooling and frustum culling

  - Add pooled per-frame uniform scratch buffers to eliminate GC pressure from per-batch Float32Array allocations
  - Add frustum culling for batched meshes to skip entire batches outside camera view
  - Build uniform template once per frame with only per-batch color patched, reducing redundant writes
  - Skip post-processing (contact shading, separation lines) during rapid camera interaction for faster frame times

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/wasm@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/spatial@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Minor Changes

- [#270](https://github.com/louistrue/ifc-lite/pull/270) [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c) Thanks [@louistrue](https://github.com/louistrue)! - Fix GPU buffer overflow on large models and optimize streaming performance

  - Automatically split color-grouped batches into sub-batches that fit within WebGPU's maxBufferSize limit, preventing createBuffer() failures on large IFC models (1+ GB with 10M+ elements)
  - Introduce lightweight fragment batches during streaming to eliminate O(N²) rebuild cost — fragments render immediately and are merged into final batches on stream completion

### Patch Changes

- [#270](https://github.com/louistrue/ifc-lite/pull/270) [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c) Thanks [@louistrue](https://github.com/louistrue)! - Fix mesh batching to handle in-place color mutations during streaming

  Color array references could be reused and mutated in-place between streaming batches, causing incorrect vertex colors when geometry was merged. The fix clones color data at accumulation time to prevent cross-batch contamination.

- Updated dependencies []:
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/spatial@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/spatial@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/spatial@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/spatial@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Minor Changes

- [#220](https://github.com/louistrue/ifc-lite/pull/220) [`5a18e6c`](https://github.com/louistrue/ifc-lite/commit/5a18e6cccbc94d244c78a571b9f2c4863326190d) Thanks [@louistrue](https://github.com/louistrue)! - Add basket presentation system with saved views, smart input sources, and presentation dock UI. The basket (pinboard) now supports saving named views with camera viewpoints, section plane state, and canvas thumbnails. Smart input resolution automatically picks the best source (selection, hierarchy, or visible scene) for basket operations. A new floating presentation dock provides set/add/remove controls and a scrollable strip of saved views for rapid scene navigation.

### Patch Changes

- [#232](https://github.com/louistrue/ifc-lite/pull/232) [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f) Thanks [@louistrue](https://github.com/louistrue)! - Fix window rendering and interaction regressions for multi-part tessellated elements. The WASM geometry pipeline now correctly triangulates `IfcIndexedPolygonalFaceWithVoids` (including inner loops) and respects optional `PnIndex` remapping, restoring correct window cutouts and subelement colors. Renderer picking, CPU raycasting, and selected-mesh lazy creation now handle all submesh pieces per element/model instead of collapsing to a single piece, and selected highlights are rendered after transparent passes so glass receives the same selection highlight as frames.

- Updated dependencies [[`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/wasm@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Minor Changes

- [#203](https://github.com/louistrue/ifc-lite/pull/203) [`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8) Thanks [@louistrue](https://github.com/louistrue)! - Add visual enhancement post-processing (contact shading, separation lines, edge contrast) and fix geometry parsing / entity type resolution

  **Renderer — visual enhancements:**

  - Add fullscreen post-processing pass (`PostProcessor`) with depth-based contact shading and object-ID-based separation lines for improved visual clarity between adjacent elements
  - Add configurable edge contrast enhancement via shader uniforms with adjustable intensity
  - New `VisualEnhancementOptions` API with independent quality presets (`off` / `low` / `high`), intensity, and radius for contact shading, separation lines, and edge contrast
  - Automatically disable expensive effects on mobile devices

  **Renderer — render pipeline changes:**

  - Add second render target (`rgba8unorm` object ID texture) to all render pipelines (opaque, transparent, overlay, instanced) for per-entity boundary detection
  - Expand vertex format from 6 to 7 floats (position + normal + entityId) across all pipelines and the picker
  - Encode entity IDs into the object ID texture via 24-bit RGB encoding in fragment shaders
  - Depth texture now created with `TEXTURE_BINDING` usage for post-processor sampling
  - Edge contrast rendering made conditional via uniform flags (`flags.z` / `flags.w`) instead of always-on

  **Renderer — geometry & scene:**

  - `GeometryManager` interleaves entity ID into the 7th float of each vertex buffer
  - `Scene` batching writes entity IDs per-vertex into merged buffers for instanced rendering

  **Data — entity type system expansion:**

  - Add ~30 new `IfcTypeEnum` entries: chimney, shading device, building element part, element assembly, reinforcing bar/mesh/tendon, discrete accessory, mechanical fastener, flow controller/moving device/storage device/treatment device/energy conversion device, duct/pipe/cable segments, furniture, proxy, annotation, transport element, civil element, geographic element
  - Add ~11 new type definition enums: pile type, member type, plate type, footing type, covering type, railing type, stair type, ramp type, roof type, curtain wall type, building element proxy type
  - Map `*StandardCase` variants (e.g. `IFCSLABSTANDARDCASE`, `IFCCOLUMNSTANDARDCASE`) to their base enum values for correct grouping
  - Expand `TYPE_STRING_TO_ENUM` and `TYPE_ENUM_TO_STRING` maps with all new types
  - Add new `ifc-entity-names.ts` with 888-line UPPERCASE → PascalCase lookup table (all IFC4X3 entity names) for correct display of any IFC entity type
  - Add `rawTypeName` field to `EntityTableBuilder` storing normalized type name as string index
  - `getTypeName()` now falls back to `rawTypeName` for types not in the enum, eliminating "Unknown" display for valid IFC types

  **Parser:**

  - Add diagnostic `console.debug` logging for spatial entity extraction and `console.warn` on extraction failures

  **WASM / Rust geometry engine:**

  - Replace overly broad geometry entity filter (`starts_with("IFC") && !ends_with("TYPE") && ...`) with explicit whitelist of ~120 IfcProduct subtypes in `has_geometry_by_name`, preventing non-product entities (e.g. `IfcDimensionalExponents`, `IfcSurfaceStyleRendering`) from being sent to geometry processing
  - Add `SolidModel` to the accepted representation types in the geometry router (6 match arms)
  - Use smooth per-vertex normals for extruded circular profiles (cylinder side walls) with `is_approximately_circular_profile` heuristic that detects circular vs polygonal profiles by coefficient of variation of radii from centroid
  - Increase circle tessellation from 24 to 36 segments for profiles (circle, circle hollow, trimmed curve, ellipse)
  - Increase swept disk solid tube segments from 12 to 24 for smoother pipes
  - Fix `PolygonalFaceSet` processing: generate flat-shaded meshes with per-face normals via `build_flat_shaded_mesh` and fix closed-shell winding orientation via `orient_closed_shell_outward`
  - Improve geometry extraction statistics: separate "no representation" (expected) from actual processing failures in diagnostic logging
  - Add `console.debug` logging for entities skipped due to missing representation

  **Viewer app:**

  - Add visual enhancement state to Zustand UI slice with 10 configurable properties (enabled, edge contrast enabled/intensity, contact shading quality/intensity/radius, separation lines enabled/quality/intensity/radius)
  - Wire `VisualEnhancementOptions` through `Viewport`, `useAnimationLoop`, and `useRenderUpdates` via memoized ref pattern
  - Show IFC type name instead of "Unknown" for spatial entities with generic names in the tree hierarchy
  - Expand `useThemeState` hook with all visual enhancement selectors

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/wasm@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/spatial@1.9.0
  - @ifc-lite/wasm@1.9.0

## 1.8.0

### Minor Changes

- [#213](https://github.com/louistrue/ifc-lite/pull/213) [`7ae9711`](https://github.com/louistrue/ifc-lite/commit/7ae971119ad92c05c521a4931105a9a977ffc667) Thanks [@louistrue](https://github.com/louistrue)! - Add basket-based multi-isolation with incremental add/remove

  - Basket isolation system: build an isolation set incrementally with `=` (set), `+` (add), `−` (remove) via keyboard, toolbar, or context menu
  - Cmd/Ctrl+Click multi-select feeds directly into basket operations — select multiple entities, then press `+` to add them all
  - Spacebar as additional shortcut to hide selected entity (alongside Delete/Backspace)
  - Escape now clears basket along with selection and filters
  - Toolbar shows active basket with entity count badge; context menu exposes Set/Add/Remove actions per entity
  - Unified EntityRef resolution via `resolveEntityRef()` — single source of truth for globalId-to-model mapping across all UI surfaces
  - Fix: Cmd+Click multi-select now works reliably in all model configurations (single-model, multi-model, legacy)

- [#205](https://github.com/louistrue/ifc-lite/pull/205) [`06ddd81`](https://github.com/louistrue/ifc-lite/commit/06ddd81ce922d8f356836d04ff634cba45520a81) Thanks [@louistrue](https://github.com/louistrue)! - Add flexible lens coloring system with GPU overlay rendering

  - Color overlay system: renders lens colors on top of original geometry using depth-equal pipeline, eliminating batch rebuild and framerate drops
  - Auto-color by any IFC data: properties, quantities, classifications, materials, attributes, and class
  - Dynamic discovery of available data from loaded models (lazy on-demand for properties, quantities, classifications, materials)
  - Classification system selector in AutoColorEditor (separates Uniclass/OmniClass)
  - Unlimited unique colors with sortable legend

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/spatial@1.8.0
  - @ifc-lite/wasm@1.8.0

## 1.7.0

### Minor Changes

- [#204](https://github.com/louistrue/ifc-lite/pull/204) [`057bde9`](https://github.com/louistrue/ifc-lite/commit/057bde9e48f64c07055413c690c6bdabb6942d04) Thanks [@louistrue](https://github.com/louistrue)! - Add orthographic projection, pinboard, lens, type tree, and floorplan views

  ### Renderer

  - Orthographic reverse-Z projection matrix in math utilities
  - Camera projection mode toggle (perspective/orthographic) with seamless switching
  - Orthographic zoom scales view size instead of camera distance
  - Parallel ray unprojection for orthographic picking

  ### Viewer

  - **Orthographic projection**: Toggle button, unified Views dropdown, numpad `5` keyboard shortcut
  - **Automatic Floorplan**: Per-storey section cuts with top-down ortho view, dropdown in toolbar
  - **Pinboard**: Selection basket with Pin/Unpin/Show, entity isolation via serialized EntityRef Set
  - **Tree View by Type**: IFC type grouping mode alongside spatial hierarchy, localStorage persistence
  - **Lens**: Rule-based 3D colorization/filtering with built-in presets (By IFC Type, Structural Elements), full panel UI with color legend and rule evaluation engine

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/spatial@1.7.0
  - @ifc-lite/wasm@1.7.0

## 1.5.0

### Minor Changes

- [#162](https://github.com/louistrue/ifc-lite/pull/162) [`463e7c9`](https://github.com/louistrue/ifc-lite/commit/463e7c934abc2fccd0a35a8eab04fbae47185259) Thanks [@louistrue](https://github.com/louistrue)! - Add symbolic representation support for 2D drawings

  - **New Feature**: Added `parseSymbolicRepresentations` WASM API to extract 2D Plan, Annotation, and FootPrint representations from IFC files
  - **New Feature**: Section2DPanel now supports toggling between section cuts and symbolic representations (architectural floor plans)
  - **New Feature**: Added hybrid mode that combines section cuts with symbolic representations
  - **New Feature**: Building rotation detection from IfcSite placement for proper floor plan orientation
  - **Enhancement**: RTC offset streaming events for better coordinate handling in large models
  - **Enhancement**: Geometry processor now reports building rotation in coordinate info
  - **Types**: Added `SymbolicRepresentationCollection`, `SymbolicPolyline`, `SymbolicCircle` types

### Patch Changes

- Updated dependencies [[`463e7c9`](https://github.com/louistrue/ifc-lite/commit/463e7c934abc2fccd0a35a8eab04fbae47185259)]:
  - @ifc-lite/geometry@1.5.0
  - @ifc-lite/wasm@1.5.0

## 1.4.0

### Patch Changes

- 0191843: feat: Add BCF (BIM Collaboration Format) support

  Adds full BCF 2.1 support for issue tracking and collaboration in BIM workflows:

  **BCF Package (@ifc-lite/bcf):**

  - Read/write BCF 2.1 .bcfzip files
  - Full viewpoint support with camera position, components, and clipping planes
  - Coordinate system conversion between Y-up (viewer) and Z-up (IFC/BCF)
  - Support for multiple snapshot naming conventions
  - IFC GlobalId mapping for component references

  **Viewer Integration:**

  - BCF panel integrated into properties panel area (resizable, same layout)
  - Topic management with filtering and status updates
  - Viewpoint capture with camera state, selection, and snapshot
  - Viewpoint activation with smooth camera animation and visibility state
  - Import/export BCF files compatible with BIMcollab and other tools
  - Email setup nudge in empty state for easy author configuration
  - Smart filename generation using model name for downloads

  **Renderer Fixes:**

  - Fix screenshot distortion caused by WebGPU texture row alignment
  - Add GPU-synchronized screenshot capture for accurate snapshots

  **Parser Fixes:**

  - Extract GlobalIds for all geometry entities (not just spatial) to enable BCF component references

  **Bug Fixes:**

  - Fix BCF viewpoint visibility not clearing isolation mode
  - Add localStorage error handling for private browsing mode
  - Fix BCF XML schema compliance for BIMcollab compatibility:
    - Correct element order (Selection before Visibility)
    - Move ViewSetupHints to Components level (not inside Visibility)
    - Write OriginatingSystem/AuthoringToolId as child elements (not attributes)
    - Always include required Visibility element

- c6a3a95: feat: Add shift+drag orthogonal constraint for measurements

  When in measure mode, holding Shift while dragging constrains measurements to orthogonal axes (X, Y, Z). This enables precise horizontal, vertical, and depth measurements.

  - Visual axis indicators show available constraint directions (red=X, green=Y, blue=Z)
  - Snaps to edges and vertices in orthogonal mode for precision
  - Shift+drag before first point allows camera orbit
  - Adaptive performance optimization for complex models

## 1.3.0

### Patch Changes

- [#117](https://github.com/louistrue/ifc-lite/pull/117) [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490) Thanks [@louistrue](https://github.com/louistrue)! - Fix multi-material rendering and enhance CSG operations

  ### Multi-Material Rendering

  - Windows now correctly render with transparent glass panels and opaque frames
  - Doors now render all submeshes including inner framing with correct colors
  - Fixed mesh deduplication in Viewport that was filtering out submeshes sharing the same expressId
  - Added SubMesh and SubMeshCollection types to track per-geometry-item meshes for style lookup

  ### CSG Operations

  - Added union and intersection mesh operations for full boolean CSG support
  - Improved CSG clipping with degenerate triangle removal to eliminate artifacts
  - Enhanced bounds overlap detection for better performance
  - Added cleanup of triangles inside opening bounds to remove CSG artifacts

- [#130](https://github.com/louistrue/ifc-lite/pull/130) [`cc4d3a9`](https://github.com/louistrue/ifc-lite/commit/cc4d3a922869be5d4f8cafd4ab1b84e6bd254302) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC5 federated loading support with layer composition

  ## Features

  - **Federated IFCX Loading**: Load multiple IFCX files that compose into a unified model

    - Supports the IFC5/IFCX Entity-Component-System architecture
    - Later files in the composition chain override earlier files (USD-inspired semantics)
    - Properties from overlay files merge with base geometry files

  - **Models Panel Integration**: Show all federated layers in the Models panel

    - Each layer (base + overlays) displayed as a separate entry
    - Overlay-only files (no geometry) shown with data indicator
    - Toggle visibility per layer

  - **Add Overlay via "+" Button**: Add IFCX overlay files to existing models
    - Works with both single-file and already-federated IFCX models
    - Automatically re-composes with new overlay as strongest layer
    - Preserves original files for future re-composition

  ## Fixes

  - **Property Panel Layout**: Long property strings no longer push other values off-screen

    - Changed from flexbox to CSS grid layout
    - Individual horizontal scroll on each property value

  - **3D Selection Highlighting**: Fixed race condition that broke highlighting after adding overlays

    - Geometry now comes exclusively from models Map (not legacy state)
    - Meshes correctly tagged with modelIndex for multi-model selection

  - **ID Range Tracking**: Fixed maxExpressId calculation for proper entity resolution
    - resolveGlobalIdFromModels now correctly finds entities across federated layers

  ## Technical Details

  - New `LayerStack` class manages ordered composition with strongest-to-weakest semantics
  - New `PathIndex` class enables efficient cross-layer entity lookups
  - `parseFederatedIfcx` function handles multi-file composition
  - Viewer auto-detects when multiple IFCX files are loaded together

- Updated dependencies [[`0c1a262`](https://github.com/louistrue/ifc-lite/commit/0c1a262d971af4a1bc2c97d41258aa6745fef857), [`fe4f7ac`](https://github.com/louistrue/ifc-lite/commit/fe4f7aca0e7927d12905d5d86ded7e06f41cb3b3), [`4bf4931`](https://github.com/louistrue/ifc-lite/commit/4bf4931181d1c9867a5f0f4803972fa5a3178490), [`07558fc`](https://github.com/louistrue/ifc-lite/commit/07558fc4aa91245ef0f9c31681ec84444ec5d80e)]:
  - @ifc-lite/wasm@1.3.0
  - @ifc-lite/geometry@1.3.0

## 1.2.1

### Patch Changes

- bd6dccd: Fix section plane activation and clipping behavior.
  - Section plane now only active when Section tool is selected
  - Fixed section plane bounds to use model geometry bounds
  - Simplified section plane axis to x/y/z coordinates
  - Fixed visual section plane rendering with proper depth testing
- bd6dccd: Add magnetic edge snapping to measure tool.
  - New raycastSceneMagnetic API for edge-aware snapping
  - Edge lock state management for "stick and slide" behavior
  - Corner detection with valence tracking
  - Smooth snapping transitions along edges

## 1.2.0

### Minor Changes

- ed8f77b: ### New Features

  - **CPU Raycasting for Picking**: Added CPU raycasting support for picking large models, improving interaction performance for complex scenes

  ### Bug Fixes

  - **Fixed Ray Origin**: Fixed ray origin to use camera position for accurate CPU picking
  - **Fixed Raycasting Logic**: Improved raycasting logic to always use CPU raycasting when batched meshes exist and creation threshold is exceeded

- ed8f77b: ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- f4fbf8c: ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- ed8f77b: ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- f7133a3: ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- b9990c7: ### Bug Fixes

  - **Fixed visibility filtering for merged meshes**: Mesh pieces are now accumulated per expressId, ensuring visibility toggling works correctly when multiple geometry pieces belong to the same IFC element
  - **Fixed spatial structure filtering**: Spatial structure types (IfcSpace, IfcSite, etc.) are now properly filtered from contained elements lists
  - **Fixed spatial hierarchy cache**: Spatial hierarchy is now correctly rebuilt when loading models from cache

- ed8f77b: ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- Updated dependencies [ed8f77b]
- Updated dependencies [f4fbf8c]
- Updated dependencies
- Updated dependencies [ed8f77b]
- Updated dependencies [f4fbf8c]
- Updated dependencies [ed8f77b]
- Updated dependencies
- Updated dependencies [f7133a3]
  - @ifc-lite/wasm@1.2.0
  - @ifc-lite/geometry@1.2.0

## 1.2.0

### Minor Changes

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **CPU Raycasting for Picking**: Added CPU raycasting support for picking large models, improving interaction performance for complex scenes

  ### Bug Fixes

  - **Fixed Ray Origin**: Fixed ray origin to use camera position for accurate CPU picking
  - **Fixed Raycasting Logic**: Improved raycasting logic to always use CPU raycasting when batched meshes exist and creation threshold is exceeded

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **IFC5 (IFCX) Format Support**: Added full support for IFC5/IFCX file format parsing, enabling compatibility with the latest IFC standard
  - **IFCX Property/Quantity Display**: Enhanced viewer to properly display IFCX properties and quantities
  - **IFCX Coordinate System Handling**: Fixed coordinate system transformations for IFCX files

  ### Bug Fixes

  - **Fixed STEP Escaping**: Corrected STEP file escaping issues that affected IFCX parsing
  - **Fixed IFC Type Names**: Improved IFC type name handling for better compatibility

- [#39](https://github.com/louistrue/ifc-lite/pull/39) [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74) Thanks [@louistrue](https://github.com/louistrue)! - ### New Features

  - **Type visibility controls**: Toggle visibility of spatial elements (IfcSpace, IfcOpeningElement, IfcSite) in the viewer toolbar
  - **Enhanced CSG operations**: Improved boolean geometry operations using the `csgrs` library for better performance and accuracy
  - **Full IFC4X3 schema support**: Migrated to generated schema with all 876 IFC4X3 types

  ### Bug Fixes

  - **Fixed unit conversion**: Files using millimeters (.MILLI. prefix) now render at correct scale instead of 1000x too large
  - **Fixed IFCPROJECT detection**: Now scans entire file to find IFCPROJECT instead of only first 100 entities, fixing issues with large IFC files

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Lite Parsing Mode**: Added optimized parsing mode for large files (>100MB) with 5-10x faster parsing performance
  - **On-Demand Property Extraction**: Implemented on-demand property extraction for instant property access, eliminating upfront table building overhead
  - **Fast Semicolon Scanner**: Added high-performance semicolon-based scanner for faster large file processing
  - **Single-Pass Data Extraction**: Optimized to single-pass data extraction for improved parsing speed
  - **Async Yields**: Added async yields during data parsing to prevent UI blocking
  - **Bulk Array Extraction**: Optimized data model decoding with bulk array extraction for better performance
  - **Dynamic Batch Sizing**: Implemented dynamic batch sizing for improved performance in IFC processing with adaptive batch sizes based on file size

  ### New Features

  - **On-Demand Parsing Mode**: Consolidated to single on-demand parsing mode for better memory efficiency
  - **Targeted Spatial Parsing**: Added targeted spatial parsing in lite mode for efficient hierarchy building

  ### Bug Fixes

  - **Fixed Relationship Graph**: Added DefinesByProperties to relationship graph in lite mode
  - **Fixed On-Demand Maps**: Improved forward relationship lookup for rebuilding on-demand maps
  - **Fixed Property Extraction**: Restored on-demand property extraction when loading from cache

- [#52](https://github.com/louistrue/ifc-lite/pull/52) [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff) Thanks [@louistrue](https://github.com/louistrue)! - ### Performance Improvements

  - **Zero-copy WASM memory to WebGPU upload**: Implemented direct memory access from WASM linear memory to WebGPU buffers, eliminating intermediate JavaScript copies. This provides 60-70% reduction in peak RAM usage and 40-50% faster geometry-to-GPU pipeline.

  - **Optimized cache and spatial hierarchy**: Eliminated O(n²) lookups in cache and spatial hierarchy builder, implemented instant cache lookup with larger batches, and optimized batch streaming for better performance.

  - **Parallelized data model parsing**: Added parallel processing for data model parsing and streaming of cached geometry with deferred hash computation and yielding before heavy decode operations.

  ### New Features

  - **Zero-copy benchmark suite**: Added comprehensive benchmark suite to measure zero-copy performance improvements and identify bottlenecks.

  - **GPU geometry API**: Added new GPU-ready geometry API with pre-interleaved vertex data, pre-converted coordinates, and pointer-based direct WASM memory access.

  ### Bug Fixes

  - **Fixed O(n²) batch recreation**: Eliminated inefficient batch recreation in zero-copy streaming pipeline.

  - **Updated WASM and TypeScript definitions**: Updated WASM bindings and TypeScript definitions for geometry classes to support zero-copy operations.

### Patch Changes

- [#46](https://github.com/louistrue/ifc-lite/pull/46) [`b9990c7`](https://github.com/louistrue/ifc-lite/commit/b9990c7913c1b8bf25366699dcfd8a1f924b0b45) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed visibility filtering for merged meshes**: Mesh pieces are now accumulated per expressId, ensuring visibility toggling works correctly when multiple geometry pieces belong to the same IFC element
  - **Fixed spatial structure filtering**: Spatial structure types (IfcSpace, IfcSite, etc.) are now properly filtered from contained elements lists
  - **Fixed spatial hierarchy cache**: Spatial hierarchy is now correctly rebuilt when loading models from cache

- [#66](https://github.com/louistrue/ifc-lite/pull/66) [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5) Thanks [@louistrue](https://github.com/louistrue)! - ### Bug Fixes

  - **Fixed Color Parsing**: Fixed TypedValue wrapper handling in color parsing
  - **Fixed Storey Visibility**: Fixed storey visibility toggle functionality
  - **Fixed Background Property Parsing**: Added background property parsing support
  - **Fixed Geometry Support**: Added IfcSpace/Opening/Site geometry support
  - **Fixed TypeScript Generation**: Fixed TypeScript generation from EXPRESS schema types
  - **Fixed Renderer Safeguards**: Added renderer safeguards for proper IFC type names

- Updated dependencies [[`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f4fbf8c`](https://github.com/louistrue/ifc-lite/commit/f4fbf8cf0deef47a813585114c2bc829b3b15e74), [`ed8f77b`](https://github.com/louistrue/ifc-lite/commit/ed8f77b6eaa16ff93593bb946135c92db587d0f5), [`f7133a3`](https://github.com/louistrue/ifc-lite/commit/f7133a31320fdb8e8744313f46fbfe1718f179ff)]:
  - @ifc-lite/wasm@1.2.0
  - @ifc-lite/geometry@1.2.0
