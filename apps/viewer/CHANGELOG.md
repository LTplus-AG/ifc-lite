# @ifc-lite/viewer

## 1.17.6

### Patch Changes

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Rotate mesh normals alongside positions when aligning federated models and honour georef mutations during alignment, so secondary models keep correct shading and stay aligned when their georeferencing is edited after load.

- [#563](https://github.com/louistrue/ifc-lite/pull/563) [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966) Thanks [@louistrue](https://github.com/louistrue)! - Extract LLM stream routing into a shared helper and handle Codex's truncation marker so long responses are no longer cut off mid-sentence. BYOK guard logic moves into its own module with unit tests covering the direct-stream path.

- Updated dependencies [[`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966), [`7a6eb5e`](https://github.com/louistrue/ifc-lite/commit/7a6eb5e249a00a61d4e7b5574e017c949b083966)]:
  - @ifc-lite/wasm@1.16.6

## 1.17.5

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

- Updated dependencies [[`8f4df0e`](https://github.com/louistrue/ifc-lite/commit/8f4df0e50e22419353829114b5af80cfd5d45805), [`7000011`](https://github.com/louistrue/ifc-lite/commit/7000011d6eb372c2dadf7c82f6e76a0583c6abc1)]:
  - @ifc-lite/renderer@1.16.0
  - @ifc-lite/drawing-2d@1.15.3
  - @ifc-lite/wasm@1.16.5

## 1.17.4

### Patch Changes

- [#531](https://github.com/louistrue/ifc-lite/pull/531) [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e) Thanks [@louistrue](https://github.com/louistrue)! - Fix browser build warnings and improve streaming reliability

  - Silence FileDialog Tauri warnings in browser builds (expected fallback path)
  - Fix closeGeometryIterator ReferenceError when geometry processor throws before iterator creation
  - Guard timer-based queue pump behind document.hidden to prevent redundant GPU flushes in foreground tabs

- Updated dependencies [[`643b30f`](https://github.com/louistrue/ifc-lite/commit/643b30ff031d389fe0cb1caf7de6989d79629e4b), [`fb6851d`](https://github.com/louistrue/ifc-lite/commit/fb6851dba2491bf8c540d9dbcc7026584da0572e)]:
  - @ifc-lite/geometry@1.16.5
  - @ifc-lite/wasm@1.16.4
  - @ifc-lite/renderer@1.15.2

## 1.17.3

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Fix type properties and type info display when selecting occurrence elements

- Updated dependencies [[`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b), [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b)]:
  - @ifc-lite/renderer@1.14.9

## 1.17.2

### Patch Changes

- [#447](https://github.com/louistrue/ifc-lite/pull/447) [`e532dfe`](https://github.com/louistrue/ifc-lite/commit/e532dfef16bedbdb7b106d610b88a97e723721c3) Thanks [@louistrue](https://github.com/louistrue)! - Enable visibility filter by default in list results table so rows are filtered by 3D visibility state out of the box

- Updated dependencies [[`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0), [`e07f960`](https://github.com/louistrue/ifc-lite/commit/e07f960097649c5f63a5abc5f35009949d54a5c0)]:
  - @ifc-lite/renderer@1.14.7
  - @ifc-lite/wasm@1.16.0
  - @ifc-lite/drawing-2d@1.15.0
  - @ifc-lite/export@1.17.0
  - @ifc-lite/geometry@1.16.0
  - @ifc-lite/server-client@1.15.0

## 1.17.1

### Patch Changes

- [#439](https://github.com/louistrue/ifc-lite/pull/439) [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6) Thanks [@louistrue](https://github.com/louistrue)! - Add Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers to vercel.json for SharedArrayBuffer support in production deployments.

- Updated dependencies [[`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6), [`a672eec`](https://github.com/louistrue/ifc-lite/commit/a672eec196ec77b0229b0953f9a1b59991f814a6)]:
  - @ifc-lite/wasm@1.15.0
  - @ifc-lite/geometry@1.15.0

## 1.17.0

### Minor Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D BCF topic marker overlay that positions markers above referenced geometry, tracks camera movement in real-time, and supports click/hover interactions with the BCF panel

### Patch Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Make BCF 3D overlay markers opt-in with a MapPin toggle button in the BCF panel header, defaulting to off for zero performance cost when unused

- [#419](https://github.com/louistrue/ifc-lite/pull/419) [`87ce884`](https://github.com/louistrue/ifc-lite/commit/87ce8841175e64394445833e66bd77a8a68668e9) Thanks [@louistrue](https://github.com/louistrue)! - Enable visibility filter by default in list results table so rows are filtered by 3D visibility state out of the box

- Updated dependencies [[`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d), [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d)]:
  - @ifc-lite/bcf@1.15.0

## 1.16.0

### Minor Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Use Material Symbols IFC class icons in hierarchy panel for improved visual clarity

### Patch Changes

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Add double-escape keyboard shortcut to close all panels and return to starting view

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Refactor internals across parser, renderer, export, and viewer packages

- [#368](https://github.com/louistrue/ifc-lite/pull/368) [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8) Thanks [@louistrue](https://github.com/louistrue)! - Show all package versions in viewer

- Updated dependencies [[`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8), [`0f9d20c`](https://github.com/louistrue/ifc-lite/commit/0f9d20c3b1d3cd88abffc27a2b88a234ef8c74c8)]:
  - @ifc-lite/wasm@1.14.4
  - @ifc-lite/parser@2.1.1
  - @ifc-lite/renderer@1.14.4
  - @ifc-lite/export@1.15.1

## 1.15.0

### Minor Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Include IfcSpace elements in storey isolation and add combinable class/type/storey filters

### Patch Changes

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix viewer.isolate() hiding everything when passed spatial structure elements like storeys

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Add dynamic IFCX schema import detection for IFC5 export

- [#354](https://github.com/louistrue/ifc-lite/pull/354) [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f) Thanks [@louistrue](https://github.com/louistrue)! - Fix mutation state not resetting when opening a new file

- Updated dependencies [[`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f), [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87), [`3f212f1`](https://github.com/louistrue/ifc-lite/commit/3f212f1e24b896cbc6ff63444c02635a1128ba3f)]:
  - @ifc-lite/ids@1.14.4
  - @ifc-lite/export@1.15.0
  - @ifc-lite/parser@2.1.0
  - @ifc-lite/encoding@1.14.4
  - @ifc-lite/lists@1.14.4

## 1.14.4

### Patch Changes

- [#339](https://github.com/louistrue/ifc-lite/pull/339) [`691f8a5`](https://github.com/louistrue/ifc-lite/commit/691f8a57ad51c0649de0dbcd17f4b7ecd48e7da7) Thanks [@louistrue](https://github.com/louistrue)! - Expose the Script Editor from a new Panels menu and consolidate auxiliary panel toggles in the viewer toolbar.

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/parser@2.0.0
  - @ifc-lite/export@1.14.4
  - @ifc-lite/query@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/sandbox@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/export@1.14.3
  - @ifc-lite/bcf@1.14.3
  - @ifc-lite/cache@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/drawing-2d@1.14.3
  - @ifc-lite/encoding@1.14.3
  - @ifc-lite/ids@1.14.3
  - @ifc-lite/lens@1.14.3
  - @ifc-lite/lists@1.14.3
  - @ifc-lite/parser@1.14.3
  - @ifc-lite/query@1.14.3
  - @ifc-lite/renderer@1.14.3
  - @ifc-lite/server-client@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3), [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/export@1.14.2
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/bcf@1.14.2
  - @ifc-lite/cache@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/drawing-2d@1.14.2
  - @ifc-lite/encoding@1.14.2
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/ids@1.14.2
  - @ifc-lite/lens@1.14.2
  - @ifc-lite/lists@1.14.2
  - @ifc-lite/mutations@1.14.2
  - @ifc-lite/query@1.14.2
  - @ifc-lite/renderer@1.14.2
  - @ifc-lite/sandbox@1.14.2
  - @ifc-lite/server-client@1.14.2
  - @ifc-lite/spatial@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0)]:
  - @ifc-lite/renderer@1.14.1
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/wasm@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/sandbox@1.14.1
  - @ifc-lite/bcf@1.14.1
  - @ifc-lite/cache@1.14.1
  - @ifc-lite/data@1.14.1
  - @ifc-lite/drawing-2d@1.14.1
  - @ifc-lite/encoding@1.14.1
  - @ifc-lite/export@1.14.1
  - @ifc-lite/ids@1.14.1
  - @ifc-lite/lens@1.14.1
  - @ifc-lite/lists@1.14.1
  - @ifc-lite/mutations@1.14.1
  - @ifc-lite/query@1.14.1
  - @ifc-lite/server-client@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.14.0
  - @ifc-lite/cache@1.14.0
  - @ifc-lite/data@1.14.0
  - @ifc-lite/drawing-2d@1.14.0
  - @ifc-lite/encoding@1.14.0
  - @ifc-lite/export@1.14.0
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/ids@1.14.0
  - @ifc-lite/lens@1.14.0
  - @ifc-lite/lists@1.14.0
  - @ifc-lite/mutations@1.14.0
  - @ifc-lite/parser@1.14.0
  - @ifc-lite/query@1.14.0
  - @ifc-lite/renderer@1.14.0
  - @ifc-lite/sandbox@1.14.0
  - @ifc-lite/server-client@1.14.0
  - @ifc-lite/spatial@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies [[`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c), [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c)]:
  - @ifc-lite/renderer@1.13.0
  - @ifc-lite/bcf@1.13.0
  - @ifc-lite/cache@1.13.0
  - @ifc-lite/data@1.13.0
  - @ifc-lite/drawing-2d@1.13.0
  - @ifc-lite/encoding@1.13.0
  - @ifc-lite/export@1.13.0
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/ids@1.13.0
  - @ifc-lite/lens@1.13.0
  - @ifc-lite/lists@1.13.0
  - @ifc-lite/mutations@1.13.0
  - @ifc-lite/parser@1.13.0
  - @ifc-lite/query@1.13.0
  - @ifc-lite/sandbox@1.13.0
  - @ifc-lite/server-client@1.13.0
  - @ifc-lite/spatial@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Minor Changes

- [#268](https://github.com/louistrue/ifc-lite/pull/268) [`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC5 (IFCX) export with full schema conversion and USD geometry

  New `Ifc5Exporter` converts IFC data from any schema (IFC2X3/IFC4/IFC4X3) to the IFC5 IFCX JSON format:

  - Entity types converted to IFC5 naming (aligned with IFC4X3)
  - Properties mapped to IFCX attribute namespaces (`bsi::ifc::prop::`)
  - Tessellated geometry converted to USD mesh format with Z-up coordinates
  - Spatial hierarchy mapped to IFCX path-based node structure
  - Color and presentation exported as USD attributes

  The export dialog is simplified: schema selection now drives the output format automatically (IFC5 → `.ifcx`, others → `.ifc`). No separate format picker needed.

  Schema converter fixes:

  - Skipped entities become IFCPROXY placeholders instead of being dropped, preventing dangling STEP references
  - Alignment entities (IFCALIGNMENTCANT, etc.) are preserved for IFC4X3/IFC5 targets

### Patch Changes

- Updated dependencies [[`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7)]:
  - @ifc-lite/export@1.12.0
  - @ifc-lite/bcf@1.12.0
  - @ifc-lite/cache@1.12.0
  - @ifc-lite/data@1.12.0
  - @ifc-lite/drawing-2d@1.12.0
  - @ifc-lite/encoding@1.12.0
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/ids@1.12.0
  - @ifc-lite/lens@1.12.0
  - @ifc-lite/lists@1.12.0
  - @ifc-lite/mutations@1.12.0
  - @ifc-lite/parser@1.12.0
  - @ifc-lite/query@1.12.0
  - @ifc-lite/renderer@1.12.0
  - @ifc-lite/sandbox@1.12.0
  - @ifc-lite/server-client@1.12.0
  - @ifc-lite/spatial@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- [#258](https://github.com/louistrue/ifc-lite/pull/258) [`6c5f36d`](https://github.com/louistrue/ifc-lite/commit/6c5f36ddb4ae1879788f433a45c8bab5eabeb496) Thanks [@louistrue](https://github.com/louistrue)! - Improve large-file load performance targeting ~3–5 s savings on a 326 MB IFC file.

  - Replace O(total_accumulated) `.reduce()` calls in `appendGeometryBatch` with O(batch_size) incremental totals
  - Defer data model parser to after geometry streaming completes (no main-thread CPU contention with WASM)
  - Accumulate color updates locally during streaming; apply single `updateMeshColors()` at complete
  - Disable IndexedDB caching for files above 150 MB (source buffer required for on-demand extraction)

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.3
  - @ifc-lite/cache@1.11.3
  - @ifc-lite/data@1.11.3
  - @ifc-lite/drawing-2d@1.11.3
  - @ifc-lite/encoding@1.11.3
  - @ifc-lite/export@1.11.3
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/ids@1.11.3
  - @ifc-lite/lens@1.11.3
  - @ifc-lite/lists@1.11.3
  - @ifc-lite/mutations@1.11.3
  - @ifc-lite/parser@1.11.3
  - @ifc-lite/query@1.11.3
  - @ifc-lite/renderer@1.11.3
  - @ifc-lite/sandbox@1.11.3
  - @ifc-lite/server-client@1.11.3
  - @ifc-lite/spatial@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- [#240](https://github.com/louistrue/ifc-lite/pull/240) [`a423e83`](https://github.com/louistrue/ifc-lite/commit/a423e8390afcb78f2de57203b26715df726335ed) Thanks [@louistrue](https://github.com/louistrue)! - Fix deferred IFC style colors not applying on first load by separating persistent mesh color updates from transient overlay color updates.

  This restores expected glass transparency and keeps first-load and cache-load colors consistent.

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/bcf@1.11.1
  - @ifc-lite/cache@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/drawing-2d@1.11.1
  - @ifc-lite/encoding@1.11.1
  - @ifc-lite/export@1.11.1
  - @ifc-lite/ids@1.11.1
  - @ifc-lite/lens@1.11.1
  - @ifc-lite/lists@1.11.1
  - @ifc-lite/mutations@1.11.1
  - @ifc-lite/parser@1.11.1
  - @ifc-lite/query@1.11.1
  - @ifc-lite/renderer@1.11.1
  - @ifc-lite/sandbox@1.11.1
  - @ifc-lite/server-client@1.11.1
  - @ifc-lite/spatial@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies [[`5a18e6c`](https://github.com/louistrue/ifc-lite/commit/5a18e6cccbc94d244c78a571b9f2c4863326190d), [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/renderer@1.11.0
  - @ifc-lite/wasm@1.11.0
  - @ifc-lite/bcf@1.11.0
  - @ifc-lite/cache@1.11.0
  - @ifc-lite/data@1.11.0
  - @ifc-lite/drawing-2d@1.11.0
  - @ifc-lite/encoding@1.11.0
  - @ifc-lite/export@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/ids@1.11.0
  - @ifc-lite/lens@1.11.0
  - @ifc-lite/lists@1.11.0
  - @ifc-lite/mutations@1.11.0
  - @ifc-lite/parser@1.11.0
  - @ifc-lite/query@1.11.0
  - @ifc-lite/sandbox@1.11.0
  - @ifc-lite/server-client@1.11.0
  - @ifc-lite/spatial@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [[`3823bd0`](https://github.com/louistrue/ifc-lite/commit/3823bd03bb0b5165d811cfd1ddfed671b8af97d8)]:
  - @ifc-lite/renderer@1.10.0
  - @ifc-lite/data@1.10.0
  - @ifc-lite/parser@1.10.0
  - @ifc-lite/wasm@1.10.0
  - @ifc-lite/ids@1.10.0
  - @ifc-lite/lists@1.10.0
  - @ifc-lite/bcf@1.10.0
  - @ifc-lite/cache@1.10.0
  - @ifc-lite/drawing-2d@1.10.0
  - @ifc-lite/encoding@1.10.0
  - @ifc-lite/export@1.10.0
  - @ifc-lite/geometry@1.10.0
  - @ifc-lite/lens@1.10.0
  - @ifc-lite/mutations@1.10.0
  - @ifc-lite/query@1.10.0
  - @ifc-lite/sandbox@1.10.0
  - @ifc-lite/server-client@1.10.0
  - @ifc-lite/spatial@1.10.0

## 1.9.0

### Minor Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Add scripting platform with sandboxed TypeScript execution and full BIM SDK.

  New packages:

  - `@ifc-lite/sandbox` — sandboxed script runner that transpiles and executes user TypeScript in a Web Worker with BIM globals (`bim.query`, `bim.select`, `bim.viewer`, etc.) isolated from the host page.
  - `@ifc-lite/sdk` — BIM SDK defining the full host↔sandbox message protocol and all namespaces: `query`, `mutate`, `viewer`, `spatial`, `export`, `lens`, `bcf`, `ids`, `drawing`, `list`, `events`.

  New viewer features:

  - **Command Palette** — `Cmd/Ctrl+K` fuzzy-search launcher for viewer actions and scripts.
  - **Script Panel** — full-screen code editor (CodeMirror) with run/stop controls, output log, and CSV download.
  - **6 built-in script templates** — quantity takeoff, fire-safety check, MEP equipment schedule, envelope check, space validation, federation compare.
  - **Recent files** — persisted list of previously opened IFC files.

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Respect system color-scheme preference on initial load.

  The app previously hardcoded dark mode. Now:

  - An inline script in `index.html` applies the correct theme class before first paint, eliminating flash of wrong theme.
  - The Zustand UI store reads from `localStorage` first, then falls back to the browser's `prefers-color-scheme` media query.
  - Theme preference persists across reloads via `localStorage`.

### Patch Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Fix scripting CSV exports missing property and quantity data.

  - `@ifc-lite/sdk` export namespace now resolves quantity-set dot-paths (`Qto_WallBaseQuantities.NetVolume`) in addition to property-set paths, so quantity columns are no longer empty in exports.
  - All 6 built-in script templates (quantity takeoff, fire-safety check, MEP schedule, envelope check, space validation, data-quality audit) updated to dynamically discover and include relevant property/quantity columns instead of hardcoding minimal attribute lists.

- Updated dependencies [[`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d)]:
  - @ifc-lite/sandbox@1.9.0
  - @ifc-lite/bcf@1.9.0
  - @ifc-lite/cache@1.9.0
  - @ifc-lite/data@1.9.0
  - @ifc-lite/drawing-2d@1.9.0
  - @ifc-lite/encoding@1.9.0
  - @ifc-lite/export@1.9.0
  - @ifc-lite/geometry@1.9.0
  - @ifc-lite/ids@1.9.0
  - @ifc-lite/lens@1.9.0
  - @ifc-lite/lists@1.9.0
  - @ifc-lite/mutations@1.9.0
  - @ifc-lite/parser@1.9.0
  - @ifc-lite/query@1.9.0
  - @ifc-lite/renderer@1.9.0
  - @ifc-lite/server-client@1.9.0
  - @ifc-lite/spatial@1.9.0
  - @ifc-lite/wasm@1.9.0

## 1.8.0

### Minor Changes

- [#212](https://github.com/louistrue/ifc-lite/pull/212) [`5d4dd1e`](https://github.com/louistrue/ifc-lite/commit/5d4dd1e40539b02af666ef8329c749d708a09e17) Thanks [@louistrue](https://github.com/louistrue)! - Add annotation selection, deletion, move, and text re-editing in 2D drawings

  - Click any annotation (measure, polygon area, text box, cloud) to select it — highlighted with a dashed blue border and corner handles
  - Press Delete/Backspace to remove the selected annotation
  - Drag to reposition any selected annotation
  - Double-click text annotations to re-enter edit mode
  - Escape exits annotation tools back to Select/Pan mode and deselects
  - "Select / Pan" option added to annotation toolbar dropdown
  - Performance: ephemeral drag state uses local refs instead of store updates, stable coordinate callbacks via refs, hit-test reads from storeRef to prevent callback cascade

### Patch Changes

- Updated dependencies [[`7ae9711`](https://github.com/louistrue/ifc-lite/commit/7ae971119ad92c05c521a4931105a9a977ffc667), [`06ddd81`](https://github.com/louistrue/ifc-lite/commit/06ddd81ce922d8f356836d04ff634cba45520a81), [`0b6880a`](https://github.com/louistrue/ifc-lite/commit/0b6880ac9bafee78e8b604e8df5a8e14dc74bc28)]:
  - @ifc-lite/renderer@1.8.0
  - @ifc-lite/lens@1.8.0
  - @ifc-lite/export@1.8.0
  - @ifc-lite/bcf@1.8.0
  - @ifc-lite/cache@1.8.0
  - @ifc-lite/data@1.8.0
  - @ifc-lite/drawing-2d@1.8.0
  - @ifc-lite/encoding@1.8.0
  - @ifc-lite/geometry@1.8.0
  - @ifc-lite/ids@1.8.0
  - @ifc-lite/lists@1.8.0
  - @ifc-lite/mutations@1.8.0
  - @ifc-lite/parser@1.8.0
  - @ifc-lite/query@1.8.0
  - @ifc-lite/server-client@1.8.0
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

- [#200](https://github.com/louistrue/ifc-lite/pull/200) [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a) Thanks [@louistrue](https://github.com/louistrue)! - Add schema-aware property editing, full property panel display, and document/relationship support

  - Property editor validates against IFC4 standard (ISO 16739-1:2018): walls get wall psets, doors get door psets, etc.
  - Schema-version-aware property editing: detects IFC2X3/IFC4/IFC4X3 from FILE_SCHEMA header
  - New dialogs for adding classifications (12 standard systems), materials, and quantities in edit mode
  - Quantity set definitions (Qto\_) with schema-aware dialog for standard IFC4 base quantities
  - On-demand classification extraction from IfcRelAssociatesClassification with chain walking
  - On-demand material extraction supporting all IFC material types: IfcMaterial, IfcMaterialLayerSet, IfcMaterialProfileSet, IfcMaterialConstituentSet, IfcMaterialList, and \*Usage wrappers
  - On-demand document extraction from IfcRelAssociatesDocument with DocumentReference→DocumentInformation chain
  - Type-level property merging: properties from IfcTypeObject HasPropertySets merged with instance properties
  - Structural relationship display: openings, fills, groups, and connections
  - Advanced property type parsing: IfcPropertyEnumeratedValue, BoundedValue, ListValue, TableValue, ReferenceValue
  - Georeferencing display (IfcMapConversion + IfcProjectedCRS) in model metadata panel
  - Length unit display in model metadata panel
  - Classifications, materials, documents displayed with dedicated card components
  - Type-level material/classification inheritance via IfcRelDefinesByType
  - Relationship graph fallback for server-loaded models without on-demand maps
  - Cycle detection in material resolution and classification chain walking
  - Removed `any` types from parser production code in favor of proper `PropertyValue` union type

### Patch Changes

- [#202](https://github.com/louistrue/ifc-lite/pull/202) [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c) Thanks [@louistrue](https://github.com/louistrue)! - Fix empty Description, ObjectType, and Tag columns in lists and show all IFC attributes in property panel

  - Lists: add on-demand attribute extraction fallback with per-provider caching for Description, ObjectType, and Tag columns that were previously always empty
  - Property panel: show ALL string/enum IFC attributes dynamically using the schema registry (Name, Description, ObjectType, Tag, PredefinedType, etc.) instead of hardcoding only Name/Description/ObjectType
  - Parser: add `extractAllEntityAttributes()` for schema-aware full attribute extraction, extend `extractEntityAttributesOnDemand()` to include Tag (IfcElement index 7)
  - Query: add `EntityNode.tag` getter and `EntityNode.allAttributes()` method for comprehensive attribute access
  - Performance: cache `getAttributeNames()` inheritance walks, hoist module-level constants
  - Fix type name casing bug where multi-word UPPERCASE STEP types (e.g., IFCWALLSTANDARDCASE) failed schema lookup

- Updated dependencies [[`0967cfe`](https://github.com/louistrue/ifc-lite/commit/0967cfe9a203141ee6fc7604153721396f027658), [`057bde9`](https://github.com/louistrue/ifc-lite/commit/057bde9e48f64c07055413c690c6bdabb6942d04), [`e0af898`](https://github.com/louistrue/ifc-lite/commit/e0af898608c2f706dc2d82154c612c64e2de010c), [`6c43c70`](https://github.com/louistrue/ifc-lite/commit/6c43c707ead13fc482ec367cb08d847b444a484a)]:
  - @ifc-lite/encoding@1.7.0
  - @ifc-lite/lists@1.7.0
  - @ifc-lite/renderer@1.7.0
  - @ifc-lite/parser@1.7.0
  - @ifc-lite/query@1.7.0
  - @ifc-lite/data@1.7.0
  - @ifc-lite/cache@1.7.0
  - @ifc-lite/export@1.7.0
  - @ifc-lite/ids@1.7.0
  - @ifc-lite/bcf@1.7.0
  - @ifc-lite/drawing-2d@1.7.0
  - @ifc-lite/geometry@1.7.0
  - @ifc-lite/lens@1.7.0
  - @ifc-lite/mutations@1.7.0
  - @ifc-lite/server-client@1.7.0
  - @ifc-lite/spatial@1.7.0
  - @ifc-lite/wasm@1.7.0

## 1.6.0

### Minor Changes

- Initial tracked version
