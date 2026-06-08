# create-ifc-lite

## 1.14.9

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

## 1.14.8

### Patch Changes

- [#955](https://github.com/LTplus-AG/ifc-lite/pull/955) [`30235c9`](https://github.com/LTplus-AG/ifc-lite/commit/30235c90d922e12d383a6d9f60c028984709001b) Thanks [@louistrue](https://github.com/louistrue)! - three.js template: render opaque IFC meshes double-sided and enable `logarithmicDepthBuffer`. IFC triangle winding is not reliably outward (the native renderer draws with `cullMode: 'none'` for the same reason), so culling one side of two coincident coplanar walls left the survivors z-fighting into a comb along the seam; and IFC models far from the origin with stacked near-coplanar slabs (a roof on a gable wall) stair-stepped without a logarithmic depth buffer. Both are fixed in the scaffolded viewer.

## 1.14.7

### Patch Changes

- [#874](https://github.com/LTplus-AG/ifc-lite/pull/874) [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85) Thanks [@louistrue](https://github.com/louistrue)! - Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, persist cache entity-index columns to avoid cache reload rescans, and update public docs away from legacy sync parse/geometry paths.

## 1.14.6

### Patch Changes

- [#632](https://github.com/louistrue/ifc-lite/pull/632) [`d1fab87`](https://github.com/louistrue/ifc-lite/commit/d1fab875f680e6b923d3a75d52459fd4514467e6) Thanks [@maxkrut](https://github.com/maxkrut)! - Fix npm package version resolution when scaffolding projects on Windows.

  `create-ifc-lite` resolves published `@ifc-lite/*` package versions by
  calling `npm view` before writing the generated template's `package.json`.
  On Windows, spawning `npm` directly from Node can fail with
  `spawnSync npm ENOENT` because the executable is exposed through the
  shell shim (`npm.cmd`) rather than as a directly spawnable binary in all
  environments. The CLI then reports this as a registry access failure, even
  though `npm view @ifc-lite/geometry version` works from the same terminal.

  Run the npm query through `cmd.exe /c npm ...` on Windows so template
  creation follows the same command resolution path as the user's shell,
  while keeping the direct `npm` spawn path unchanged on other platforms.

## 1.14.5

### Patch Changes

- [#507](https://github.com/louistrue/ifc-lite/pull/507) [`7b0a5f6`](https://github.com/louistrue/ifc-lite/commit/7b0a5f6a395e49d2dc846b3c955b0ba01b75c88b) Thanks [@louistrue](https://github.com/louistrue)! - Repair create-ifc-lite template scaffolds with installable package versions and dedicated React starter

## 1.14.4

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.13.0

### Minor Changes

- [#270](https://github.com/louistrue/ifc-lite/pull/270) [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c) Thanks [@louistrue](https://github.com/louistrue)! - Add Babylon.js viewer template to create-ifc-lite scaffolding

  New `babylonjs` template option for `create-ifc-lite` that generates a complete Babylon.js-based IFC viewer with geometry streaming, selection, and camera controls. Includes full example project and documentation tutorial.

## 1.11.5

### Patch Changes

- [#262](https://github.com/louistrue/ifc-lite/pull/262) [`d204ed8`](https://github.com/louistrue/ifc-lite/commit/d204ed807484a3a6b337a1186dcea311626493ad) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM loading in threejs template: revert to `optimizeDeps.exclude: ['@ifc-lite/wasm']` (matching the working example). `vite-plugin-wasm` was incorrect — the wasm-bindgen `new URL('ifc-lite_bg.wasm', import.meta.url)` pattern works correctly when the package is excluded from Vite pre-bundling.

## 1.11.4

### Patch Changes

- [#260](https://github.com/louistrue/ifc-lite/pull/260) [`e342a43`](https://github.com/louistrue/ifc-lite/commit/e342a430c07b4611b94225a74776e9855bf1450a) Thanks [@louistrue](https://github.com/louistrue)! - Fix WASM loading in threejs template: add `vite-plugin-wasm` and `vite-plugin-top-level-await` to vite config. Without these plugins Vite cannot serve the `.wasm` file with the correct `application/wasm` MIME type, causing a `CompileError: wasm validation error` at runtime.

## 1.11.3

### Patch Changes

- [#257](https://github.com/louistrue/ifc-lite/pull/257) [`025d3b1`](https://github.com/louistrue/ifc-lite/commit/025d3b14161e63045f8c79b58b49c7da4d91594b) Thanks [@louistrue](https://github.com/louistrue)! - Fix all template TypeScript errors caught by new CI audit:

  - basic template: add `@types/node` + `types: ["node"]` in tsconfig; fix `Buffer` → `ArrayBuffer` conversion when calling `IfcParser.parse()`
  - Add `test-templates.yml` CI workflow that scaffolds every template, runs `npm install` + `tsc --noEmit` (+ `vite build` for threejs) on every PR touching `packages/create-ifc-lite`

- [#257](https://github.com/louistrue/ifc-lite/pull/257) [`b1dd28b`](https://github.com/louistrue/ifc-lite/commit/b1dd28beccbec361651dc61d71a9b32d12b03071) Thanks [@louistrue](https://github.com/louistrue)! - Fix TypeScript error in generated Three.js template: use non-null assertions on DOM element declarations so type narrowing works across function boundaries.

## 1.11.2

### Patch Changes

- [#251](https://github.com/louistrue/ifc-lite/pull/251) [`a13e5c0`](https://github.com/louistrue/ifc-lite/commit/a13e5c04eaf6369815eb66af5174a724a4e38937) Thanks [@louistrue](https://github.com/louistrue)! - Fix TypeScript errors in generated Three.js template: add explicit type casts for `HTMLCanvasElement` and `HTMLInputElement` DOM queries; disable OrbitControls damping for sharp camera stops.

## 1.8.1

### Patch Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Fix react template generating wrong `@ifc-lite/*` versions in package.json.

  Previously all workspace dependencies were replaced with the latest version of
  `@ifc-lite/parser`, which broke installs when a package (e.g. `@ifc-lite/sandbox`)
  had not yet been published at that version. Each package is now queried
  individually from the npm registry so the generated package.json always
  references the actual published version of every dependency.

## 1.6.1

### Patch Changes

- [#182](https://github.com/louistrue/ifc-lite/pull/182) [`5e78765`](https://github.com/louistrue/ifc-lite/commit/5e78765139b6c9c28612ae3f9e58760ccc9b524e) Thanks [@louistrue](https://github.com/louistrue)! - Fix **APP_VERSION** not defined error in react template by adding Vite define config

## 1.1.8

### Patch Changes

- 8cb195d: Fix Ubuntu setup issues and monorepo resolution.
  - Fix `@ifc-lite/parser` worker resolution for Node.js/tsx compatibility
  - Fix `create-ifc-lite` to properly replace `workspace:` protocol in templates
