# @ifc-lite/embed-sdk

## 1.14.6

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/embed-protocol@1.14.5

## 1.14.5

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

## 1.14.4

### Patch Changes

- [#760](https://github.com/LTplus-AG/ifc-lite/pull/760) [`1282b13`](https://github.com/LTplus-AG/ifc-lite/commit/1282b13fbaf8db90197ebd3d272f59d3031810ed) Thanks [@louistrue](https://github.com/louistrue)! - Ship compiled JavaScript instead of raw TypeScript source.

  Both packages previously published with `main`/`types`/`exports` pointing at
  `./src/index.ts` and no build step, so the tarball contained only
  `src/index.ts`. A plain `npm install` + `import` failed with
  `Unknown file extension ".ts"` in Node, and the packages were fragile under
  `tsc`, Jest, ts-node, and non-esbuild bundlers — despite `@ifc-lite/embed-sdk`
  being intended for external embedding (Power BI, Superset, Grafana).

  They now build with `tsc` to `dist/` and export `./dist/index.js` +
  `./dist/index.d.ts`, matching every other publishable package in the repo.

- Updated dependencies [[`1282b13`](https://github.com/LTplus-AG/ifc-lite/commit/1282b13fbaf8db90197ebd3d272f59d3031810ed)]:
  - @ifc-lite/embed-protocol@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.0
