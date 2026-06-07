# @ifc-lite/drawing-2d

## 1.17.0

### Minor Changes

- [#989](https://github.com/LTplus-AG/ifc-lite/pull/989) [`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e) Thanks [@louistrue](https://github.com/louistrue)! - Construction projection for 2D floor plans ([#979](https://github.com/LTplus-AG/ifc-lite/issues/979)). Project geometry beyond the
  section cut as architectural reference lines — thin solid for the visible floor
  side, dashed for overhead elements (beams, roofs, eaves).

  New public API:

  - `SectionConfig.projectionBelowDepth` / `projectionAboveDepth` — band depths
    for the visible/overhead split (default to `projectionDepth`).
  - `GeneratorOptions.outlineProvider` — inject a winding-robust footprint outline
    (the Rust `meshOutline2d` binding) for non-extruded geometry; falls back to
    the mesh silhouette when absent.
  - `projection-bands` exports: `classifyDepthRange`, `classifySegmentBand`,
    `signedDepth`, `bandVisibility`, `projectPointForPlane`,
    `getViewDirectionForPlane`, `outlineToProjectionLines`, and the
    `ProjectionBand` / `ProjectionBandDepths` / `MeshOutline2D` types.

  `Drawing2DGenerator.generate`'s projection stage now sources lines from
  profile boundaries + mesh silhouettes (replacing the noisy crease-edge path)
  and classifies them into the below/above bands.

### Patch Changes

- Updated dependencies [[`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f)]:
  - @ifc-lite/geometry@2.4.0

## 1.16.2

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/geometry@2.3.0

## 1.16.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/geometry@2.0.0

## 1.16.0

### Minor Changes

- [#650](https://github.com/louistrue/ifc-lite/pull/650) [`2ff772d`](https://github.com/louistrue/ifc-lite/commit/2ff772d0174f8cd6657f7e4090e15bc7744e8158) Thanks [@louistrue](https://github.com/louistrue)! - Arbitrary-normal section planes with face-pick (Bonsai-style) and a
  properly-rendered cap on tilted planes (#243). Click any face in the
  section tool's "Pick" mode to cut through it; the kept half-space
  defaults to the side facing the camera. The cardinal "Down / Front /
  Side" presets are unchanged.

  Renderer:

  - New `planeBasis(normal)` + `nearestCardinalAxis(normal)` exports
    derive a deterministic in-plane basis used by both the cap renderer
    and the 2D cutter — without a single shared derivation the cap hatch
    rotated when state was reconstructed.
  - `SectionPlaneRenderOptions` and `SectionPlane` gain optional
    `normal` + `distance` fields. When set, the shader clips on that
    plane verbatim (no axis mapping, no building-rotation, no
    position-percentage math) and the gizmo renders as a violet quad
    oriented from `planeBasis(normal)`.
  - `Section2DOverlayRenderer.uploadDrawing` accepts an optional
    `customPlane = { origin, tangent, bitangent }`. When supplied it
    replaces the cardinal-axis 2D→3D coordinate swap with
    `origin + tangent·x + bitangent·y`, so the cap silhouette lands
    exactly on the tilted plane (the bug PR #581 hid by suppressing the
    cap entirely for non-cardinal planes).

  Drawing-2d:

  - `SectionPlaneConfig` gains an optional `customPlane`. `SectionCutter`
    uses it verbatim for the plane equation and projects intersections
    to 2D via `(dot(p − origin, tangent), dot(p − origin, bitangent))`,
    matching the cap renderer's lift exactly.
  - `DrawingGenerator` now rebuilds the CPU cutter on each `generate()`
    call so a switch from cardinal to custom (or between custom planes)
    takes effect immediately.

  Tests: 11 new viewer tests covering normalisation, sign-preserving
  cardinal mapping, basis orthonormality, half-space flip, slice
  clearing on cardinal preset, and degenerate-normal handling. 6 new
  renderer tests covering basis derivation across cardinal axes,
  near-axis tilts, and the +Y / −Y reference-axis boundary.

## 1.15.3

### Patch Changes

- [#561](https://github.com/louistrue/ifc-lite/pull/561) [`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805) Thanks [@louistrue](https://github.com/louistrue)! - 3D section cap with screen-space hatches, driven by exact cut polygons.

  ### `@ifc-lite/renderer`

  - **3D cut surface (cap) rendering.** `Section2DOverlayRenderer` gained
    a fill pipeline that paints the user's cap style on top of the exact
    polygons `SectionCutter` produces from triangle-plane intersection.
    Eight built-in screen-space hatch patterns are supplied via the new
    `section-cap-style.ts` module: `solid`, `diagonal`, `crossHatch`,
    `horizontal`, `vertical`, `concrete` (clean dot grid, ISO 128-50),
    `brick`, `insulation`. Pattern ids match the numeric branches in the
    fill fragment shader and are pinned by unit tests so changes can't
    drift silently. New `Section2DOverlayCapStyle` shape carries fill,
    stroke, pattern id, spacing/angle/width, and a secondary cross-hatch
    angle.
  - **Outline + fill toggle independently.** `Section2DOverlayOptions`
    has new `showFills` and `showOutlines` booleans, both honoured by
    `Section2DOverlayRenderer.draw()`, so callers can hide the cut hatch
    without losing the line drawing or vice versa.
  - **Cap respects model depth.** Both fill and outline pipelines test
    with `depthCompare: 'greater-equal'` (reverse-Z) and don't write
    depth, so when the camera looks through closer model geometry the
    cap is occluded naturally. Cap polygons live exactly on the plane,
    so equal-depth ties tie cleanly with greater-equal.
  - **Cap fill landed exactly on the plane.** Removed the old 0.3 m
    vertical bias that made the hatch visibly drift off the slider
    position; the fill now sits on the cut surface itself.
  - **Depth format unified at `depth24plus-stencil8`.** Main, instanced,
    section-plane preview, and 2D overlay pipelines all declare the same
    depth/stencil format and route through `PIPELINE_CONSTANTS.DEPTH_FORMAT`
    so the literal lives in exactly one place. All in-pass pipelines also
    declare both colour attachments (main colour + objectId, the latter
    with `writeMask: 0`) so WebGPU validation passes regardless of which
    shaders render inside the section render pass.
  - **`flipped` flag plumbed end-to-end.** Main and instanced fragment
    shaders pack `enabled` (bit 0) + `flipped` (bit 1) into one flag slot
    and negate the keep side when flipped — slider position stays where
    it is, only the kept half swaps.
  - **`SectionCapStyle`, `HatchPatternId`, `DEFAULT_CAP_STYLE`, and
    `HATCH_PATTERN_IDS` exported from the package** as the canonical
    styling primitives consumed by the viewer store and the fill shader.
  - **Renderer log on first section enable** (`[Section] Y-up bounds
used for clip: …`) so a user can verify the slider range matches
    their geometry without opening a debugger.

  ### `@ifc-lite/drawing-2d`

  - **Plane equation no longer changes when `flipped`.** Both
    `SectionCutter` and `gpu-section-cutter` now build the plane normal
    from `getAxisNormal(axis, false)` regardless of the flipped flag.
    Previously the flipped normal was paired with an unchanged
    `planeDistance`, which described a different plane (`y = -position`
    instead of `y = position`) — the cutter then looked for intersections
    far outside the model and produced an empty 2D drawing. `flipped` is
    still honoured by `projectTo2D` so the resulting drawing mirrors
    correctly when viewed from the opposite side.

  ### `viewer`

  - **`SectionCapControls` panel.** New compact controls inside the
    expanded Section panel: independent Display toggles for _Surfaces_
    (cap fill) and _Lines_ (outline), hatch pattern dropdown, fill +
    stroke colour pickers, and Spacing / Angle / Width number inputs in
    a 3-col grid. The hatch fieldset disables itself when Surfaces are
    off so users can't tweak settings that don't apply. Every control
    has an explicit `id`/`htmlFor` association via `useId()` for
    assistive tech.
  - **Flip button reflects state.** Now toggles `variant` to `default`,
    carries `aria-pressed`, and swaps `aria-label`/`title` between
    "Flip cut direction" and "Unflip cut direction".
  - **Auto-enable on slider/axis change.** Moving the position slider or
    picking a direction now sets `enabled: true` so users no longer get
    stuck in a no-op "preview mode" wondering why nothing cuts. The
    bottom toggle relabelled "Clip on/off" instead of the old
    "Cutting/Preview" wording that read as if the cut was always live.
  - **2D panel auto-fits on Flip.** `useViewControls` now triggers
    `fitToView` on `sectionPlane.flipped` change as well as axis change,
    so flipping doesn't park the polygons off-screen and leave the
    panel blank.
  - **Cap style persists across reloads.** `showCap`, `showOutlines`,
    and the full `capStyle` (fill, stroke, pattern, spacing, angle,
    width, secondary angle) round-trip to `localStorage` under the keys
    `ifc-lite:section-cap-show`, `ifc-lite:section-outlines-show`, and
    `ifc-lite:section-cap-style`. `resetSectionPlane()` clears them so
    the default button actually resets. `resetViewerState()` (called on
    every IFC load) preserves persisted cap settings and only clears
    axis/position/enabled/flipped — so opening a new file no longer
    wipes the user's hatch and colour choices.
  - **Cap style types deduplicated.** `SectionCapHatchId` and
    `SectionCapStyle` in the viewer store are now re-exports of the
    renderer's `section-cap-style.ts`, so adding a new pattern only
    requires editing the renderer.
  - **localStorage failures are diagnosable.** Every persistence catch
    in `sectionSlice` now logs via `console.warn` instead of a bare
    `catch {}` — quota / private-mode / serialisation failures still
    fall back gracefully but show up in devtools.

## 1.15.2

### Patch Changes

- [#552](https://github.com/louistrue/ifc-lite/pull/552) [`aeb5edf`](https://github.com/louistrue/ifc-lite/commit/aeb5edf89605d103582f68866c92d69ef6cb4635) Thanks [@louistrue](https://github.com/louistrue)! - Fix `ERR_MODULE_NOT_FOUND` when the published packages are loaded by Node's native ESM resolver (SSR, serverless, Vitest Node mode, CI test runners, etc.).

  Several relative imports in the source omitted the `.js` extension. Under the old workspace `moduleResolution: "bundler"` TypeScript tolerated them and emitted the specifiers verbatim, so `dist/*.js` shipped extensionless relative imports. Bundlers (Vite/webpack/esbuild) resolved them transparently, but Node's native ESM resolver strictly requires the file extension and threw `ERR_MODULE_NOT_FOUND` — most visibly in `@ifc-lite/renderer`'s `dist/snap-detector.js` importing `./raycaster`.

  All offending relative imports have been rewritten to include explicit `.js` (or `/index.js` for directory imports), and every publishable package's TypeScript config now uses `module: "nodenext"` + `moduleResolution: "nodenext"` so the TypeScript compiler rejects extensionless relative imports at build time, preventing regressions. Every published package has been smoke-imported via `node --input-type=module` to verify the fix end-to-end.

## 1.15.1

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/geometry@1.16.2

## 1.15.0

### Minor Changes

- [#456](https://github.com/louistrue/ifc-lite/pull/456) [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0) Thanks [@louistrue](https://github.com/louistrue)! - Add LOD geometry generation, profile projection for 2D drawings, and streaming server integration

### Patch Changes

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/geometry@1.16.0

## 1.14.3

### Patch Changes

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/geometry@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607)]:
  - @ifc-lite/geometry@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/geometry@1.7.0

## 1.4.0

### Minor Changes

- Initial release of drawing-2d and mutations packages

  - @ifc-lite/drawing-2d: 2D architectural drawing generation (section cuts, floor plans, elevations)
  - @ifc-lite/mutations: Mutation tracking and property editing for IFC models
