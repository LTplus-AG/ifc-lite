# @ifc-lite/bcf

## 1.18.1

### Patch Changes

- Updated dependencies [[`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797)]:
  - @ifc-lite/encoding@2.0.0

## 1.18.0

### Minor Changes

- [#2479](https://github.com/LTplus-AG/ifc-lite/pull/2479) [`d38e71f`](https://github.com/LTplus-AG/ifc-lite/commit/d38e71feb2778cc2e9a5ee333b4f01339600dc9e) Thanks [@louistrue](https://github.com/louistrue)! - Close the five remaining paths by which a non-finite value reaches camera state: gesture arguments, model bounds, the unprojection basis, the `normalize` floor that both the picking ray and the pose pass through, and a viewpoint restore's reference distance.

  The gestures validated the pose but took their arguments on trust, so a finite pose could be destroyed from the caller's side instead of the file's. `orbit`, `pan` and `moveFirstPerson` each turned a healthy pose non-finite in one call for both NaN and Infinity, and `zoom` did for NaN — its delta clamp `Math.min(|d| * s, MAX)` absorbs Infinity but not NaN, an asymmetry the rest of this family does not share. The inertia velocities are worse than one bad frame: they accumulate in place and are only spent while `Math.abs(v) > minVelocity`, which is false for NaN, so a single poisoned argument would latch orbit, pan or zoom inertia dead for the session, never applied and never decaying. The cursor-anchored zoom divides by the canvas dimensions; the old truthiness test rejected `0` and `NaN` because both are falsy, but accepted a negative width, which mirrors the anchor, and `Infinity`, which pins it to a screen edge — and it never checked the cursor coordinates at all. A non-finite gesture argument now leaves the pose exactly as it found it, and an unusable cursor anchor — a non-finite coordinate or an unusable canvas extent — degrades to the un-anchored zoom, `orthoSize` included, rather than refusing to zoom. In-app event handlers cannot produce these values — wheel and pointer deltas are browser-guaranteed finite, the SpaceMouse driver clamps its axes, the pinch delta is a subtraction rather than a division, and every canvas writer floors the drawing buffer — so the route this guards is the published one, which `docs/guide/quickstart.md` and the `create-ifc-lite` template both teach by wiring raw browser input straight into these methods. `Renderer.resize` is hardened for the same reason: `canvas.width` is an IDL `unsigned long`, so it silently coerces a non-finite argument to `0`, and no pick guard in the package checks the drawing buffer.

  `frameBounds`, `zoomExtent`, `fitToBounds`, `setPresetView` and `fitBoundsAdaptive` all compute a centre and an extent from an AABB and write both into the pose — and, orthographically, into `orthoSize`, which `getOrthoSize()` reads and a saved viewpoint persists, so a bad fit outlived the session. The bounds are not caller-authored constants: every AABB accumulator in the package seeds `min = +Infinity, max = -Infinity` and narrows on a bare comparison, which is false for a non-finite vertex, so a mesh with no finite vertex hands out that inverted sentinel as if it were a real box — `model-bounds-tracker.test.ts` already pinned exactly that value — and `Scene.getEntityBoundingBox` neither filters it nor declines to cache it. An unusable box is now rejected and the camera keeps the pose it had, which is the same policy `setAspect`, `setFOV` and `setOrthoSize` settled on; there is no meaningful clamp for an infinite extent and no previous bounds to fall back to at these stateless entry points. A _degenerate_ box — a flat wall, a single point — is explicitly still framed. The two writers that bypassed `setOrthoSize` (the orthographic zoom and the animator's interpolation) now go through the same clamp, which also catches the reachable overflow of a legitimately huge half-height scaled by one more zoom-out notch.

  `unprojectToRay` returned a `(NaN, NaN, NaN)` ray origin for a non-finite `camera.up`, for both flavours, while the rendered frame stayed perfectly finite. That value leaves the package into picking and measurement, which test hits with comparisons — all false against NaN — so the click read as empty space rather than as an error. The orthographic branch was rebuilding its own screen basis with none of `lookAt`'s degeneracy handling, and that is what settles the design question: because `lookAt` substitutes a deterministic basis when `up` carries no usable orientation, there _is_ a well-defined frame on screen, and the ray must belong to it. `viewBasis` is now the single source of both, so they cannot drift; returning `null` instead would have failed a pick on a frame the user can see and pushed a branch onto every caller of a published API. The same function supplies the ray origin, so a non-finite camera position no longer produces a ray for a pose that was never rendered, and a viewport with no extent reads as a centred cursor rather than as an infinite one.

  The last member of the family is the floor inside `normalize` itself, in both copies of it: `MathUtils.normalize` (published) floored on `len < 1e-10` and the camera controls' private copy on `len > 1e-10`. Both are magnitude tests, so an infinite length passes them, and scaling by `1 / Infinity` turns an infinite component into NaN while the finite ones go to a clean `0` — a result that is neither finite nor the zero vector every caller falls back on, so the degenerate-case branch could not see it. Both are reached from inputs that are finite throughout, which is why no earlier guard in this family caught them: `MathUtils.invert` stores its result in a `Float32Array`, so an inverse component past 3.4e38 saturates to `Infinity` and `unprojectToRay` returned a direction of `{NaN, 0, -0}` — the silent picking miss again, this time in the perspective branch; and `cross(forward, up)` overflows component-wise for an `up` at the top of the double range, which put NaN into all six coordinates of `position` and `target` on one cursor-anchored wheel notch, past an `isUsableUp` that is a finiteness test and therefore accepts `Number.MAX_VALUE`. `normalize` is now total in both places: everything it cannot normalize is the zero vector, which is what its callers already handle.

  On the BCF side, `parsePoint` extracted coordinates with a bare `parseFloat`, which has no out-of-band failure value: `"NaN"` parses to `NaN` and the well-formed literal `"1e999"` parses to `Infinity`. A coordinate, `FieldOfView` or `ViewToWorldScale` that is not a real number is now reported the same way a missing element already was, so the camera is dropped and the rest of the viewpoint — selection, visibility, clipping, snapshot — still applies; every call site already handled that signal, so this adds no new branch. Separately, the conversions that turn a viewpoint into a viewer pose take the viewer's live `camera.getDistance()` as their reference distance, and that value is raw by contract, so once a pose was broken by any route every restore computed `target = viewPoint + direction * NaN` — meaning restoring a known-good viewpoint, the obvious way out, could not repair the camera. `perspectiveToCamera`, `orthogonalToCamera` and `computeMarkerPositions` now fall back to their documented defaults for a reference distance that is not usable, which is one guard at the sink every restore path funnels through rather than one per app-layer consumer; there are six of those, and guarding them individually is the arrangement that produced the gap.

### Patch Changes

- Updated dependencies [[`eb39b27`](https://github.com/LTplus-AG/ifc-lite/commit/eb39b27f5eba186b23b3a683c25fff2c60084d9c), [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171)]:
  - @ifc-lite/encoding@1.16.0

## 1.17.0

### Minor Changes

- [#2315](https://github.com/LTplus-AG/ifc-lite/pull/2315) [`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix BCF 3.0 `BimSnippet` and `DocumentReference` being written and read in the BCF 2.1 shape, which made our 3.0 output schema-invalid and silently dropped or corrupted the equivalent fields when reading a spec-correct 3.0 file from another vendor's tool.

  Three divergences between the two schema versions were unhandled (all per `buildingSMART/BCF-XML` `markup.xsd`):

  - `BimSnippet`'s external flag is `isExternal` in 2.1 and `IsExternal` in 3.0. The reader only matched the lowercase spelling, so a spec-correct 3.0 file with `IsExternal="true"` read back as `isExternal: false` — a silent wrong value, not a parse failure. The writer emitted lowercase at version 3.0. The same rename is already handled for the `Header`/`<File>` attribute; this applies the identical treatment to `BimSnippet`.
  - `DocumentReference` replaced 2.1's `<ReferencedDocument>` plus `isExternal` with a choice of `<DocumentGuid>` (a reference into `project.bcfp`'s Documents) or `<Url>`, dropping `isExternal` entirely. The reader required `<ReferencedDocument>` to be present, so every reference in a 3.0 file was dropped; the writer emitted the 2.1 shape regardless of version.
  - 3.0 groups the entries under a single `<DocumentReferences>` container, while 2.1 repeats `<DocumentReference>` directly under `<Topic>`. The writer emitted the 2.1 containment at version 3.0.

  `BCFDocumentReference` gains optional `documentGuid` and `url`, and `isExternal`/`referencedDocument` become optional since 3.0 has no equivalent — hence a minor rather than a patch, as reading either field now requires a presence check.

### Patch Changes

- [#2310](https://github.com/LTplus-AG/ifc-lite/pull/2310) [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a zip-slip hazard in `writeBCF`: a viewpoint GUID is parsed unvalidated from untrusted markup XML on read, and was used verbatim in the `Viewpoint_<guid>.bcfv` / `Snapshot_<guid>.*` zip entry names. A crafted GUID containing `../` on a read-modify-save (e.g. `ifc-lite bcf add-comment`) could write a zip entry outside the archive root. The topic GUID already went through a sanitizer for the same reason; the viewpoint GUID now goes through the same sanitizer, computed once per viewpoint so the markup `<Viewpoint>` filename reference and the actual zip entry always agree.

  ifc-lite's own reader is in-memory and unaffected by this; the risk is a re-exported `.bcfzip` containing entries with literal `../` segments that could escape the archive root in a downstream tool that extracts entries by joining names onto a directory.

- Updated dependencies [[`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642)]:
  - @ifc-lite/encoding@1.15.1

## 1.16.3

### Patch Changes

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Harden BCF archive I/O and the CSV formula-injection guard.

  BCF writer now sanitizes a topic GUID before using it as a zip folder name, so a GUID parsed from untrusted markup (`../../evil`) can no longer traverse outside the archive root on a read-modify-save (zip-slip). Sanitized names that collide (`a?b` and `a:b` both map to `a_b`) are disambiguated with a hash of the original GUID plus a counter backstop, so no topic silently overwrites another. BCF reader now caps the compressed input size, the raw zip record count (scanned from the buffer, so duplicate-pathname floods that JSZip dedupes to one visible entry are still counted), and the declared expanded size; because declared sizes are attacker-controlled, the expansion cap is additionally enforced on the ACTUAL decompressed bytes as entries stream out, aborting mid-entry. Entries declaring invalid (negative-reading) sizes are rejected outright.

  The lists CSV export formula-injection guard no longer quotes genuine numeric cells: `-0.35` and `+1` export unquoted (summable in Excel), while real injection vectors (`=`, `@`, tab/CR, and a leading `-`/`+` that is not a plain number such as `-cmd` or `-1+cmd`) are still prefixed with an apostrophe.

- Updated dependencies [[`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe)]:
  - @ifc-lite/encoding@1.14.11

## 1.16.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/encoding@1.14.10

## 1.16.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/encoding@1.14.9

## 1.16.0

### Minor Changes

- [#1619](https://github.com/LTplus-AG/ifc-lite/pull/1619) [`6be7ad4`](https://github.com/LTplus-AG/ifc-lite/commit/6be7ad477e1f20d6ba1a90e5b5db4645fc48a960) Thanks [@louistrue](https://github.com/louistrue)! - `BCFTopic` gains an optional `header?: BCFHeaderFile[]` field: the source IFC file(s) a topic refers to (markup `<Header>`), one entry per distinct model a federated topic spans, so a topic round-trips the provenance of every model it touches (issue [#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591)).

  `writeBCF` now emits the `<Header>` block (version-correct: BCF 2.1 nests `<File>` directly, BCF 3.0 wraps them in `<Files>`), and `readBCF` parses it back into `topic.header`. Both are additive: topics without header files emit no `<Header>` element and existing markup output is unchanged.

## 1.15.7

### Patch Changes

- [#1548](https://github.com/LTplus-AG/ifc-lite/pull/1548) [`ec89d3f`](https://github.com/LTplus-AG/ifc-lite/commit/ec89d3f871f54b58fbfe32915ac6304505de1174) Thanks [@louistrue](https://github.com/louistrue)! - Fix BCF round-trip data loss. On read, XML entities in titles, descriptions, comments, and labels are now unescaped, so `&`, `<`, `>`, `"`, `'` come back exactly as written instead of as literal entities. The comment parser no longer truncates every comment to an empty string: the outer `<Comment Guid="...">` wrapper shares its tag name with its nested `<Comment>` text field, so the parser now slices each wrapper's span up to the next wrapper (or end of markup) and takes the last `</Comment>` as its real close. That is robust across BCF 2.1 and 3.0 (where comments sit inside a `<Comments>` container) and tolerates unknown vendor elements, so no comment is silently dropped. On write, `BimSnippet` (when it carries the schema-required `ReferenceSchema`) and `DocumentReference` are now emitted; they were parsed and typed but never written, so they were silently dropped on every export.

## 1.15.6

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/encoding@1.14.7

## 1.15.5

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

## 1.15.4

### Patch Changes

- [#831](https://github.com/LTplus-AG/ifc-lite/pull/831) [`8b48495`](https://github.com/LTplus-AG/ifc-lite/commit/8b48495bc65c8ca778c3b60f271108f641fafe02) Thanks [@jonatanjacobsson](https://github.com/jonatanjacobsson)! - Color 3D BCF topic markers by topic status instead of priority, and match the active-marker pulse ring to the status color.

## 1.15.3

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Add CesiumJS 3D Tiles integration with synchronized camera controls, and expose renderer camera state for external consumers.

## 1.15.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/encoding@1.14.6

## 1.15.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/encoding@1.14.5

## 1.15.0

### Minor Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D BCF topic marker overlay that positions markers above referenced geometry, tracks camera movement in real-time, and supports click/hover interactions with the BCF panel

### Patch Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Fix XSS vulnerability by escaping marker status text before HTML injection in overlay renderer

## 1.14.3

## 1.14.2

## 1.14.1

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

## 1.10.0

## 1.9.0

## 1.8.0

## 1.7.0

## 1.4.0

### Minor Changes

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
