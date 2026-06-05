---
"@ifc-lite/collab-server": patch
"@ifc-lite/parser": patch
"@ifc-lite/geometry": patch
"@ifc-lite/query": patch
"@ifc-lite/mutations": patch
"@ifc-lite/drawing-2d": patch
"@ifc-lite/export": patch
"@ifc-lite/collab": patch
"@ifc-lite/viewer-core": patch
"@ifc-lite/mcp": patch
"@ifc-lite/server-bin": patch
"@ifc-lite/cli": patch
"@ifc-lite/data": patch
"@ifc-lite/sdk": patch
"@ifc-lite/clash": patch
"@ifc-lite/ifcx": patch
"@ifc-lite/pointcloud": patch
"@ifc-lite/bcf": patch
"@ifc-lite/server-client": patch
"@ifc-lite/sandbox": patch
"@ifc-lite/embed-sdk": patch
"@ifc-lite/cache": patch
"@ifc-lite/lists": patch
"@ifc-lite/renderer": patch
"@ifc-lite/extensions": patch
"@ifc-lite/wasm": patch
"@ifc-lite/spatial": patch
"@ifc-lite/lens": patch
"@ifc-lite/codegen": patch
"@ifc-lite/ids": patch
"create-ifc-lite": patch
---

Fix a batch of verified findings from a full-codebase review (security, correctness,
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
- extensions: inner-ring capability check fails *closed* for unknown namespaces; signing
  canonicalization is now injective (length-prefixed).
- correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
  comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
  spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
  point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
  output escaping; and more.
