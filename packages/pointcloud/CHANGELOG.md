# @ifc-lite/pointcloud

## 0.3.0

### Minor Changes

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - E57 multi-scan pose merging — registered files now load.

  Previously a multi-scan E57 with `<pose>` elements threw a clear
  "re-export as merged" error. This change parses each Data3D's pose
  (unit quaternion + translation) and applies it before merging, so
  registered scans line up in the file's global frame.

  Implementation:

  - `Data3DEntry.hasPose: boolean` → `Data3DEntry.pose?: E57Pose`
    carrying `{ rotation: {w,x,y,z}, translation: {x,y,z} }`.
  - New `parsePoseElement` walks the `<pose><rotation/><translation/></pose>`
    structure; non-finite values fall through to identity rather than
    rejecting the whole file.
  - New exported `applyPoseInPlace(positions, count, pose)` derives the
    3×3 rotation matrix from the quaternion (Hamilton convention,
    `w + xi + yj + zk`) and computes `out = R · in + T` per point.
  - `decodeE57` applies the pose after `decodeE57Scan` returns and
    recomputes bbox; identity / absent poses are no-ops.
  - The "Multi-scan pose merging is not yet supported" rejection is
    removed.

  3 new tests:

  - Pose extraction from XML (90°-around-Z quaternion + finite
    translation, plus a no-pose sibling).
  - `applyPoseInPlace` with a 90°-around-Z + translation, asserting
    per-axis transforms.
  - Identity pose round-trips positions unchanged.

  Verified: 64 pointcloud unit tests pass, full repo typecheck (24/24),
  viewer Vite build green.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - E57 ScaledInteger codec — bit-packed cartesian / intensity / colour.

  ScaledInteger is the more compact encoding most real-world Faro,
  Trimble, and Leica E57 exports use; previously we threw a clear
  error on these files. This change implements the decoder so they
  load directly.

  Per spec ASTM E2807-11 §6.3.4:

  - `bitsPerRecord = ceil(log2(maximum - minimum + 1))`
  - Bytestream stores `raw_int = original − minimum` packed LSB-first
    within each byte; decoded float = `(raw_int + minimum) * scale + offset`

  Implementation:

  - New `readBitsLE(bytes, bitOffset, bitsPerRecord)` walks a byte
    buffer and reconstructs each value into a JS number using
    `Math.pow(2, n)` instead of `<< n`, so precision holds up to 53
    bits (covers every real exporter — LiDAR + survey kit tops out
    around 32 bits). Wider fields throw a clear error.
  - `readCartesianStream` and `readIntensityStream` now branch on
    field kind: Float / Integer paths unchanged, ScaledInteger path
    bit-walks per record.
  - `writeColorChannel` extended with a ScaledInteger branch that
    remaps `raw → [0, 1]` via the declared min/max range.
  - Per-axis packet capacity computation now varies by field kind
    (Float = `length / byteSize`, ScaledInteger = `length * 8 / bitsPerRecord`)
    via `floatOrSiPointCapacity`.

  The "ScaledInteger throws clearly" error is removed for cartesian,
  intensity, and colour — all three now decode. The earlier multi-scan
  pose rejection stays in place; that's a separate piece of work.

  2 new tests:

  - 8-bit ScaledInteger across all three cartesian axes (round-trip
    through known raw values).
  - 12-bit ScaledInteger that crosses byte boundaries (proves the
    bit-pack walk is correct for non-multiples-of-8).

  Verified: 63 pointcloud unit tests pass, full repo typecheck (24/24),
  viewer Vite build green.

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - PTS / XYZ ASCII point cloud reader.

  Both formats are line-oriented plain-text scans common in legacy
  survey workflows. They share the same syntax — they differ only in
  the optional first-line point count (PTS may have one; XYZ never
  does). One shared decoder + streaming source handles both.

  Auto-detected per-line layouts (by column count of the first data
  line):

  - 3 cols → `X Y Z`
  - 4 cols → `X Y Z I` (intensity)
  - 6 cols → `X Y Z R G B`
  - 7 cols → `X Y Z I R G B` (canonical PTS)
  - 9 cols → `X Y Z R G B Nx Ny Nz` (XYZ-with-normals; normals dropped)
  - 10 cols → `X Y Z I R G B Nx Ny Nz` (PTS-with-normals; normals dropped)
  - For XYZ with unknown column counts ≥3 we still emit positions and
    skip the rest, so weird custom exports load instead of erroring.

  Other behaviour:

  - Comment lines (`#`, `//`) and blank lines are skipped.
  - Intensity normalisation: 0..1 vs 0..255 vs raw sensor detected from
    the observed maximum, then mapped to u16.
  - RGB normalisation: same heuristic (>1.0 → 0..255 source).
  - Whole-file decode wrapped in `AsciiPointsStreamingSource`; the
    streaming host's 25M-point cap stride-downsamples on the way out.

  Wired into the decode worker, format detection
  (`detectPointCloudFormat` returns `'pts'` / `'xyz'`), the file
  picker accept lists, drop handlers, and both `useIfcLoader` /
  `useIfcFederation` ingest branches. The "PTS / XYZ ASCII points —
  not yet supported" toast is removed from `describeUnsupportedFormat`.

  10 new unit tests cover layout probing, decoder round-trips for the
  common shapes, and the comment / header-count edge cases.

### Patch Changes

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Fix LAZ load failing with `WebAssembly: Response has unsupported MIME
type 'text/plain'` on real-world files (e.g. autzen-classified.laz).

  `laz-perf`'s emscripten shim resolves the wasm via `locateFile()` and
  calls `fetch("laz-perf.wasm")` relative to its own script directory.
  In a Vite-bundled module worker that path becomes `/assets/<chunk>/…`
  or just `/laz-perf.wasm` — both 404, and the SPA fallback returns
  `index.html` as `text/plain`, which `instantiateStreaming` rightly
  rejects. The async fallback then 404s the same way and aborts.

  `loadLazPerf` now resolves the wasm asset URL through Vite's
  `?url` import (`laz-perf/lib/web/laz-perf.wasm?url`), pre-fetches the
  bytes itself, and hands them to emscripten as `Module.wasmBinary` so
  the shim's own fetch is bypassed entirely. Failure modes (asset
  resolution, fetch HTTP error) now produce a precise error message
  naming the URL and status instead of the opaque emscripten "Aborted".

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Near-term batch — correctness + robustness items from #611.

  **`computeBBox` empty / non-finite guards.** Both `e57.ts` and
  `ifcx-points.ts` now return `{0,0,0}/{0,0,0}` for empty arrays and
  skip non-finite triplets. Previously a zero-point or NaN-poisoned
  chunk produced ±Infinity bounds that broke camera fit-to-view and
  section-plane sliders.

  **Magic-byte-first format detection.** `detectPointCloudFormat` now
  probes the buffer (E57 magic, LASF magic, "ply" / "#" / ".PCD"
  ASCII tokens) before falling back to extension. A LAS file
  mistakenly named `*.ply` no longer goes down the wrong decoder. LAS
  vs LAZ still uses the extension to disambiguate (they share the
  LASF magic).

  **E57 packet-bounds + per-stream guards.** Validate that the
  DataPacket header, bytestream-length table, and each individual
  bytestream stay inside `payloadEnd = packetEnd - 4` before reading.
  Corrupt files now fail with a precise "bytestream X runs past
  packet payload" error instead of silently reading into the next
  packet.

  **`e57.ts` split (631 → 4 files).** `e57-page.ts` (header / page CRC
  / section-header resolver), `e57-xml.ts` (prototype + Data3D
  parser), `e57-decode.ts` (per-scan binary decoder), `e57.ts`
  (orchestrator + re-exports). All four under the AGENTS ~400-line
  guideline.

  **`point-cloud-renderer.ts` extract.** Pulled the uniform-block
  writer into `point-cloud-uniforms.ts` (`writePointCloudUniforms` +
  mode index maps). Renderer drops below 400 lines.

  Verified: 62 pointcloud unit tests pass, full repo typecheck
  (24/24).

- [#614](https://github.com/louistrue/ifc-lite/pull/614) [`7efc878`](https://github.com/louistrue/ifc-lite/commit/7efc8783314559b674509131f1e203ae7c1fda8e) Thanks [@louistrue](https://github.com/louistrue)! - Round 2 of CodeRabbit feedback on PR #614:

  - **E57 stride downsampling drops classifications.** `applyStride` rebuilt
    positions / colors / intensities into new arrays but never copied the
    per-point class IDs, so any non-default stride (`{ stride: 2 }` and up)
    silently lost them and `hasClassification` flipped to false.
  - **Federation abort can stomp a newer load.** The AbortError handler in
    `useIfcFederation.addModel()` wrote `progress`, `error`, and `loading`
    unconditionally — if a second `addModel()` started after the first was
    cancelled, it lost its spinner and progress to the cancelled load's
    cleanup. Added a `loadSessionRef` token (mirrors `useIfcLoader`) and
    gate state writes on `loadSessionRef.current === currentSession`.
  - **E57 Integer classification subtracts `minimum`.** Class IDs are
    absolute labels (ASPRS LAS 1.4 0..31), not range-normalised offsets.
    `raw - minimum` was corrupting class IDs whenever a producer declared
    a non-zero `minimum` on the Integer-encoded classification field. The
    Integer branch now matches the ScaledInteger branch's intent: keep
    the raw byte, clamp to 0..255.
  - **PCD probe missed `VERSION` / `FIELDS` headers.** The magic-byte
    detector only recognised `# .PCD …` comment-style headers. Real PCDs
    emitted by PCL's `pcl_io` and a few third-party tools start directly
    with `VERSION 0.7\n…` or `FIELDS x y z\n…` — these now route through
    the PCD decoder instead of falling through to extension-based
    detection (which would mis-route a renamed PCD).
  - **Catch-block logging.** Per repo convention, log point-cloud ingest
    failures in `useIfcLoader.ts` before the early return so abort vs.
    real-failure vs. stale-session paths are distinguishable in console
    triage.

  Test cleanup: drop the shadowed (and unused) ScaledInteger packet
  buffer in `e57.test.ts` so only the live `fullBuf` setup remains.

## 0.2.0

### Minor Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - E57 reader (subset) + clear errors when users drop unsupported formats.

  **E57 (ASTM E2807-11) reader.**

  - 48-byte FileHeader parser (`ASTM-E57` magic + xmlPhysicalOffset/Length
    - pageSize).
  - Page-CRC stripping: every 1024-byte physical page ends with 4 bytes
    of CRC32-C; we strip them to get the logical view that XML offsets
    reference. CRCs aren't validated (faster + still correct on
    well-formed files).
  - XML parser via `DOMParser` walks `e57Root → data3D → vectorChild` and
    extracts each scan's record count, binary fileOffset, and prototype
    fields.
  - Binary section decoder walks DataPackets, reads bytestream length
    table, decodes uncompressed Float32 / Float64 cartesianX/Y/Z plus
    optional Float colors and Integer u8 colorRed/Green/Blue.
  - ScaledIntegerNode encoding throws a clear error so the host can guide
    the user to a Float-encoded export.

  **Drop UX.** Dropping a file we can't load (Recap `.rwp/.rwi/.rwcx/.dmt`,
  `.skp`, `.zip`, Faro `.fls`, ASCII `.pts/.xyz`) now shows an
  explanatory toast describing what the format is and what to do
  (typically: "export to E57 / LAS / PLY"). Previously the drop was
  silently rejected.

  **File picker** accepts `.e57` in browser drop, the native dialog, and
  the recent-files command palette.

  7 new pointcloud unit tests cover the FileHeader parser, page-CRC
  stripping (full pages and partial trailing page), the binary packet
  walker on a hand-built single-packet scan with Float64 cartesianX/Y/Z

  - uint8 RGB, and the ScaledInteger error path.

  Tests: 48 pointcloud unit tests pass, full repo typecheck (24/24),
  test suite green (22 runs), viewer Vite build emits decode-worker
  chunk correctly.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Fix LAZ loading + add PLY / PCD as standalone formats; sliders feel
  responsive on first contact.

  **LAZ silently failed to load.** `laz-perf` is shipped as CommonJS,
  which Vite/webpack wrap under `.default` differently across builds.
  The previous probe only checked `lazPerf.createLazPerf` and
  `lazPerf.default` (as a function), so all real-world LAZ loads threw
  "could not find createLazPerf factory". The probe now walks four
  candidate shapes (named export, `default.createLazPerf`, `default` as
  function, namespace-as-function) and reports the visible keys when
  none match.

  **PLY + PCD now load directly.** Two new streaming sources backed by
  the existing format decoders:

  - `PlyStreamingSource` — ASCII + binary little/big-endian, optional
    RGB (uchar) + intensity. Header probe (64 KB) + whole-file decode.
  - `PcdStreamingSource` — wraps `decodePcd` (already supported PCD
    ASCII / binary / binary_compressed via inline LZF).

  Both use stride downsampling for the host's 25M-point cap.

  **Format detection** sniffs `.ply` (magic "ply"), `.pcd` (`# .P` or
  `.PCD` token), and the existing `.las/.laz` paths.

  **File picker** accepts `.ply` and `.pcd` in browser drop, the native
  dialog, and the recent-files command palette.

  **Slider UX.** Default size mode is now `fixed-px` (was `attenuated`).
  The previous default felt inert because the slider in `attenuated` mode
  is the upper _cap_ on adaptive sizing — at typical wide views the
  projected world-radius sat well below the cap, so dragging the slider
  1↔20 px never engaged. `fixed-px` always uses the slider value, and
  "Auto" is one click away when users want adaptive behaviour.

  **Worker URL fix.** `worker-client.ts` now imports
  `./decode-worker.ts` (matching geometry's pattern) so Vite's worker
  plugin resolves through the source-alias path. The package's build
  script post-rewrites that to `.js` for dist consumers.

  Tests: 41 pointcloud unit tests pass (7 new for PLY ascii/binary +
  header probe + truncation), full repo typecheck (24/24), full test
  suite (22 runs green), viewer Vite build emits the decode-worker
  chunk correctly.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Phase 0 of full point cloud loading: render the buildingSMART IFCx
  pointcloud samples (`pcd::base64`, `points::array`, `points::base64`).

  - New `@ifc-lite/pointcloud` package: renderer-agnostic decoders for PCD
    (ASCII / binary / binary_compressed via inline LZF) and the two inline
    IFCx point schemas. Pure TS, no three.js, no WebGPU.
  - `@ifc-lite/geometry` adds `PointCloudAsset` and `GeometryResult.pointClouds`.
  - `@ifc-lite/ifcx` adds `extractPointClouds()` and surfaces decoded scans
    on `IfcxParseResult.pointClouds`. The mesh extractor is unchanged.
  - `@ifc-lite/parser` re-exports the new `PointCloudExtraction` type.
  - `@ifc-lite/renderer` gains a WGSL `topology: 'point-list'` pipeline,
    per-asset GPU buffers, and `Renderer.setPointClouds()` /
    `Renderer.addPointClouds()`. Points share the depth buffer and section
    plane state with the triangle pipeline.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Phases 1–4 of point cloud loading.

  - **LAS streaming** (`.las` files) — header parser + per-point record decoder
    for ASPRS Point Data Formats 0–10, with auto-detection of "8-bit RGB
    in u16 channels" producers and on-the-fly rescaling.
  - **LAZ streaming** (`.laz` files) — wraps `laz-perf` (Apache-2.0) as a
    runtime dep, decoded inside a Web Worker so the main thread stays
    responsive.
  - **Streaming pipeline** — Blob-backed byte source, decode worker with a
    postMessage protocol that ships chunks back as transferable typed-array
    buffers, host-side controller that paces decode, applies a 25M-point
    memory cap with stride downsampling, and reports progress / completion.
  - **Renderer streaming API** — `Renderer.beginPointCloudStream`,
    `appendPointCloudChunk`, `endPointCloudStream`, `removePointCloudAsset`,
    `setPointCloudOptions`. Streamed assets coexist with IFCx-derived
    assets in separate ownership buckets so `setPointClouds` doesn't clobber
    active streams.
  - **Color modes** — `rgb` / `classification` (ASPRS palette) / `intensity` /
    `height` (cool-warm ramp) / `fixed`. Per-point classification + intensity
    travel through the GPU vertex layout and the WGSL shader picks the
    channel based on the active mode uniform.
  - **Viewer integration** — file picker accepts `.las,.laz` (browser drop +
    native dialog), a small bottom-left panel exposes the color modes when
    point clouds are loaded, and the federation registry's `modelIndex`
    flows through streaming ingest for multi-model picking parity.

  GPU-based point picking is deferred to a follow-up; clicks on points
  return null and don't crash existing mesh selection.

### Patch Changes

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - E57: read the 32-byte CompressedVector section header before walking
  DataPackets.

  Per E57 spec §6.4.2, every CompressedVector binary section starts with
  a 32-byte header (sectionId + reserved + sectionLogicalLength +
  dataPhysicalOffset + indexPhysicalOffset) BEFORE the first DataPacket.
  The XML's `points@fileOffset` points at that section header, not at
  the packets.

  The previous decoder walked packets straight from `points@fileOffset`,
  so the first byte (sectionId == 1) was misread as packetType (1 ==
  data — coincidentally also valid), and the u16 at offset 4 was the
  low half of `sectionLogicalLength`, which decoded as `bytestreamCount
= 0`. That produced the user-reported error
  `bytestreamCount (0) ≠ prototype length (7)` on every real-world E57.

  New `resolveCompressedVectorDataOffset` reads the section header,
  validates `sectionId == 1`, and follows `dataPhysicalOffset` to the
  actual logical packet start. `decodeE57` now applies it to every
  entry before passing through to `decodeE57Scan`.

  3 new tests cover: correct dataPhysicalOffset translation, wrong
  sectionId rejection, and out-of-bounds section header rejection.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - E57 reader: replace `DOMParser` with worker-safe XML parser.

  `DOMParser` doesn't exist in dedicated Web Workers, where the decode
  pipeline runs. Loading any `.e57` file failed with `DOMParser is not
defined` before reaching the binary section.

  New `xml-mini.ts` ships a small purpose-built SAX-style parser:
  open/close + self-closing tags, double-quoted attribute values, element
  text, standard XML entities, and the usual skip cases (XML declaration,
  DOCTYPE, comments, CDATA). Scope is deliberately narrow — just enough
  for E57's shallow attribute-heavy shape — so the worker bundle stays
  small.

  `parseE57Xml` now walks the mini-parser's tree instead of a DOM. The
  public API and decoder behaviour are unchanged; the only observable
  difference is that E57 files actually load now.

  Tests: 8 new tests for the XML parser (nesting, entities, mismatched
  tags, attributes containing `>`), 2 for `parseE57Xml` against a
  representative E57-shaped XML body. Total package tests: 58.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Three Codex review fixes on the streaming ingest path.

  **Streamed point cloud assets leaked across model removal.** The
  renderer handle returned from `beginPointCloudStream` was discarded,
  and streamed nodes are intentionally outside the IFCx
  `setPointClouds` bucket, so removing a model left the GPU buffers
  allocated for the rest of the session. `FederatedModel` now carries
  an optional `pointCloudHandleId`; both ingest sites populate it; a
  new `usePointCloudLifecycle` hook diffs the model map on every
  change and frees handles for models that disappear.

  **Double cleanup on ingest failure.** The outer `try/catch` in both
  ingest sites called `removePointCloudAsset` + `incCount(-1)`, but
  `ingestPointCloud`'s `onError` already does the same before
  rethrowing. The duplicate cleanup pushed the asset counter negative
  and caused a "remove twice" warning. The outer `catch` now only
  handles store / UI state.

  **PCD header probe.** The streaming source used the file's reported
  size as the upper bound for the header probe; on truncated files
  that walked off the end with a confusing error. Capped the probe at
  4 KiB so malformed PCD headers fail with a clear "header > 4 KiB"
  message.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Round 3 of point cloud fixes — correctness gaps that block multi-model
  sessions and silent rendering stalls.

  **Federation relabel for streamed point clouds.**
  `ingestPointCloud` now emits a synthetic entry on
  `geometryResult.pointClouds`. Without this, `useIfcFederation`'s
  `idOffset` fold + `relabelPointCloudAsset` call never fired for
  LAS/LAZ/PLY/PCD/E57 streams, so picked `expressId`s for streamed
  assets collided across federated models.

  **Sync-throw cleanup.** Wrap `streamPointCloud()` in `try/catch`
  inside `ingestPointCloud`. The renderer asset and asset-count
  increment happen before the worker spins up, so a sync throw during
  validation/worker setup used to leak both. We now `removePointCloudAsset`

  - `onCountChange(-1)` before re-throwing.

  **`setPointClouds()` shrinks bounds correctly.** The replace path
  called `expandModelBoundsForPointClouds` (grow-only). Reloading IFCx
  with a smaller scan kept stale extents until `clear`. Switched to
  `recomputeModelBounds()` so bounds re-baseline from current state.

  **`requestRender()` after every mutation.** `appendPointCloudChunk`,
  `setPointCloudOptions`, `setEdlOptions`, `setPointClouds`,
  `addPointClouds`, `clearPointClouds`, `removePointCloudAsset`,
  `endPointCloudStream` now schedule a frame. Previously streamed
  chunks could sit invisible until an unrelated camera move triggered
  the next render.

  **Worker cancel race.** `worker-client.next()` now re-checks
  `signal.aborted` after `await session.send()`. A chunk that won the
  race against `cancel()` would otherwise still call `onChunk` after
  the host returned to the caller.

  **Multi-scan E57 rejection.** `parseE57Xml` now records `hasPose` per
  Data3D entry. `decodeE57` rejects multi-scan files where any entry
  carries a `<pose>` element, with a clear "registered multi-scan;
  re-export as merged" error. Previously such files silently
  concatenated in scan-local space and rendered misaligned.

  Verified: 62 pointcloud unit tests (1 new for pose flag), full repo
  typecheck (24/24), viewer Vite build green.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Address CodeRabbit + Codex review feedback on PR #608.

  Critical visual / correctness fixes:

  - Point splats rendered ~2× too large because the shader treated the
    user-facing `pointSizePx` (diameter) as the splat radius. Fixed in
    both the live splat shader and the picker shader so click targets
    match the rendered disc.
  - Routed every detected point-cloud format (`ply`, `pcd`, `e57`) through
    the streaming ingest in both `useIfcLoader` (single-file drop) and
    `useIfcFederation` (multi-file). Previously only `las/laz` got the
    pointcloud branch; `ply/pcd/e57` fell through into the IFC STEP path.
  - Federation: applied `idOffset` to `geometryResult.pointClouds` too so
    multi-pointcloud-model loads don't collide on local `expressId`.
  - `expressId` defaulted to `1` on every ingest, so multiple inline LAS
    loads collided. Now uses a process-local synthetic counter.
  - E57 integer color channels are commonly u16 (0..65535); reader was
    forcing u8 reads, distorting RGB. Now picks element width from the
    declared min/max range.
  - PCD `applyStride` preserved positions + colors but dropped intensity
    and classification, so those color modes silently broke on files
    past the 25M-point downsample cap.
  - Inline `uploadAssetToGpu` forwards `intensities` + `classifications`
    (added to `PointCloudAsset.chunk` shape).
  - Model bounds recomputed after `removePointCloudAsset` /
    `clearPointClouds` — previously stayed oversized, breaking
    fit-to-view and section sliders.
  - `usePointCloudLifecycle` disposes a model's GPU asset when the model
    stays in the store but its `pointCloudHandleId` changes (re-stream of
    the same file used to leak the old handle).
  - `resetViewerState` now clears the point-cloud slice runtime fields so
    loading a new file doesn't inherit the previous file's color mode /
    size / EDL state.

  Correctness / robustness:

  - `streamPointCloud`'s host now closes the source on probe + onOpen
    failures (single try/finally wrapping the whole open-and-decode
    flow), so worker-backed sources don't leak the decoder on parse
    errors or aborts.
  - `worker-client.close()` clears cached `info`; subsequent `open()`
    actually re-opens instead of returning stale info next to a null
    `sourceId`.
  - `LasStreamingSource.open()` and `LazStreamingSource.open()` are
    atomic on failure: state is committed only after every step
    succeeds, so a retry rerruns the probe + RGB-scale detection
    cleanly. LAZ also frees malloc'd wasm pointers in the catch path.
  - PLY decoder rejects files where `vertex` isn't the first element
    (decoder reads from `header.bodyOffset`; non-leading vertex would
    silently produce garbage).
  - `decodePointsArray` validates each `colors[i]` is a `[r,g,b]` triple
    before indexing, so malformed schemas fail with a clear message.
  - `useIfcLoader` LAS/LAZ/PLY/PCD/E57 branch is guarded by
    `loadSessionRef` on both error and success paths so a newer load can
    replace an in-flight one without overwriting the newer model state;
    stale renderer handle is freed.

  Critical webhook fixes:

  - `ViewportOverlays.tsx` had three imports between executable code;
    hoisted them above the `const isDesktop = isTauri()` declaration.
  - `edl-pass.ts` used `0u` for `texture_depth_multisampled_2d`'s
    `sample_index`; WGSL spec requires `i32`.
  - `pcd.test.ts` switched from `__dirname` to
    `fileURLToPath(import.meta.url)` so it works outside vitest's
    CommonJS-compat shim.

  UX polish:

  - `PointCloudPanel` toggle buttons expose `aria-pressed` so screen
    readers announce the active option.
  - `pointCloudSlice` setters reject `NaN`/`Infinity` (Math.min/max
    passes them through unchanged).
  - `BlobByteSource.read` clamps a negative `start` to `0`.
  - File-dialog filters split GLB out of the IFC bucket into a "Mesh
    Files" group.

  The flattenMatrix transpose flagged in the review is actually correct
  for USD's row-major-with-translation-in-row-3 convention (verified by
  inspecting the Point_Cloud_S1 sample's transform; the rendered scan is
  at the right world position). Added a clarifying comment so future
  reviewers don't reach for the wrong fix.

- [#608](https://github.com/louistrue/ifc-lite/pull/608) [`0b8c860`](https://github.com/louistrue/ifc-lite/commit/0b8c860d3e13c8b498c515854db74e0850ce59f1) Thanks [@louistrue](https://github.com/louistrue)! - Round 2 of CodeRabbit review fixes — correctness + robustness.

  P1 (real correctness):

  - Federation: streamed point clouds now get the post-`idOffset` global
    expressId in picking output. New `Renderer.relabelPointCloudAsset()`
    updates a per-asset uniform (`flags.x`) the shader prefers over the
    per-vertex attribute, so federation is just a metadata write — no
    GPU buffer rewrite. `useIfcFederation.addModel` calls it after the
    pointClouds offset is applied.
  - Section-plane range now folds in `pointCloudRenderer.getBounds()`, so
    pure point-cloud scenes don't fall through to `[-100, 100]` and mixed
    scenes don't clip points outside a smaller mesh-only range.
  - `recomputeModelBounds()` now recomputes from scratch (mesh baseline +
    current pc bounds) instead of growing-only. Previously, removing one
    of several point clouds left stale oversized extents until every
    point cloud was gone.
  - `streamPointCloud` validates `chunkSize > 0` upfront; `LasStreamingSource`
    and `LazStreamingSource` reject `maxPoints <= 0`. Prevents
    zero-progress decode loops from accidental misuse.
  - E57 merge uses `some()` instead of `every()`; mixed-attribute files
    no longer drop colour/intensity for the whole merged cloud just
    because one scan lacks the channel.
  - E57 intensity is now allocated for `Integer`-encoded prototypes too
    (was silently dropped); `ScaledInteger` throws a clear error.

  P2 (robustness):

  - `xml-mini` rejects truncated input — unclosed elements throw instead
    of silently returning a partial tree.
  - `worker-client.next()` now sends a `kind: 'abort'` to the worker when
    the signal fires mid-flight. Previously cancel returned to the caller
    while the worker kept decoding.
  - `decodePointsArray` rejects empty arrays (was producing ±Infinity
    bbox); `decodePointsBase64` rejects empty strings (no silent
    downgrade to uncoloured cloud).
  - `transformPositionsZUpToYUp` guards against zero / non-finite
    homogeneous `w` (malformed `usd::xformop` matrices).

  P3 (polish):

  - `POINT_CLOUD_DEFAULTS` is now an exported constant shared by the
    slice initializer and `resetViewerState`, so the two paths can't
    drift.
  - Replaced `as any` cast around `AbortSignal.any` with a typed
    intersection.
  - Doc comment on `pointCloudSizeMode` now matches the actual default
    (`fixed-px`).

  Verified: 61 pointcloud unit tests pass, full repo typecheck (24/24),
  test suite green (22 runs), viewer Vite build emits decode-worker
  chunk correctly.
