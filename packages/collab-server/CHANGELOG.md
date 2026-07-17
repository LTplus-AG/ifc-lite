# @ifc-lite/collab-server

## 0.5.0

### Minor Changes

- [#1774](https://github.com/LTplus-AG/ifc-lite/pull/1774) [`8a0b09f`](https://github.com/LTplus-AG/ifc-lite/commit/8a0b09f161fffbc3302e173bd639a5aa85074e59) Thanks [@louistrue](https://github.com/louistrue)! - Harden the collab server, MCP path guard, and point-cloud decoders against abuse and hostile input.

  - collab-server: rate-limit the unauthenticated fresh-room token-mint path per client IP (authenticated admin re-mints are exempt) and cap `claimedRooms` growth (`COLLAB_MAX_CLAIMED_ROOMS`, default 100k). `X-Forwarded-For` is IGNORED by default when deriving the rate-limit IP (a spoofable header would hand every request its own bucket); set `COLLAB_TRUST_PROXY=1` (or `tokenEndpoint.trustForwardedFor`) behind a trusted reverse proxy, which then uses the LAST header entry (the hop the proxy itself appended).
  - collab-server: access-control persistence (revocations + claimed rooms) is now debounced, written atomically (temp file + rename, no torn state file on crash), and flushed on SIGINT/SIGTERM; `flush()` rejects (and the CLI exits non-zero, loudly) when the state never reached disk. Startup is fail-closed: a present-but-unreadable or malformed state file throws instead of running open, and a MISSING state file on a data dir that already has persisted rooms marks those rooms claimed (admins re-mint with their still-valid admin bearers; squatters cannot first-claim them). Revocations now persist as `jti -> exp` (the legacy `revoked: string[]` shape still loads) and are pruned once the revoked token would have expired anyway, so the deny-list stays bounded without ever evicting a live revocation. The policy moved from `bin.ts` into an exported `createAccessControl` for reuse and testing.
  - collab-server: a ref that requires human approval now refuses approvals when its reviewer allowlist is empty (previously any non-author principal could self-approve past the merge gate).
  - collab-server: metrics-token comparison hashes both sides to fixed-length digests before `timingSafeEqual`, removing the length oracle; startup without `COLLAB_TOKEN_SECRET` on a non-loopback host logs an explicit OPEN-server warning; idle rooms unload after `COLLAB_IDLE_UNLOAD_MS` (default 5 min) so long-lived deployments can't wedge at `maxRooms`.
  - mcp: the safe-path guard now also refuses shell startup/persistence files (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, …) and the `~/.config` tree for both read and write.
  - pointcloud: E57/PCD/PLY decoders reject header-declared record/point/vertex counts (and LZF uncompressed sizes) that the actual body bytes cannot back, so a small hostile file can no longer force multi-GB allocations before the first read fails; ascii floors allow EOF-terminated final records. The PCD LZF expansion bound is format-derived (90x, above LZF's real 88x back-reference maximum, so genuinely repetitive valid files decode) plus an absolute 1 GiB uncompressed ceiling; PCD field SIZE/COUNT must be positive safe integers and the accumulated stride may not overflow. PLY element counts are parsed strictly, and list-valued properties on the vertex element (variable-length records the fixed-stride readers cannot walk) are rejected up front.

## 0.4.1

### Patch Changes

- [#1742](https://github.com/LTplus-AG/ifc-lite/pull/1742) [`da19eb6`](https://github.com/LTplus-AG/ifc-lite/commit/da19eb6e6f56384112b71344178d0a317b9986c5) Thanks [@louistrue](https://github.com/louistrue)! - Merging a candidate that is already on the target ref now no-ops (fast-forward with the ref unchanged) instead of refusing with unrelated-base. Published drafts land on their home ref with a declared base equal to the composition they were authored against, which need not be representable on the ref, so re-merging them previously dead-ended. Registry merge previews now also report `ancestor_matched` so clients can warn before an execute would be refused.

- Updated dependencies [[`da19eb6`](https://github.com/LTplus-AG/ifc-lite/commit/da19eb6e6f56384112b71344178d0a317b9986c5)]:
  - @ifc-lite/merge@0.3.1

## 0.4.0

### Minor Changes

- [#1726](https://github.com/LTplus-AG/ifc-lite/pull/1726) [`e092198`](https://github.com/LTplus-AG/ifc-lite/commit/e092198070cd4311cbfe0a85a4dbd88c702d2919) Thanks [@louistrue](https://github.com/louistrue)! - Durable layer registry: `FsLayerRegistry` persists content-addressed layers, refs (with policies), and review objects to disk under the collab data dir, so a registry survives restarts. The deployed binary mounts it with `COLLAB_LAYER_REGISTRY=1`. Shared push-integrity gate extracted as `assertPushableLayer`.

- [#1727](https://github.com/LTplus-AG/ifc-lite/pull/1727) [`7dac702`](https://github.com/LTplus-AG/ifc-lite/commit/7dac702db0092a3a3d6a447b2e49bc9591f5dfc4) Thanks [@louistrue](https://github.com/louistrue)! - Check evidence becomes fetchable (08-review.md §8.4): the registry gains `PUT/GET /api/v1/reports/<digest>` (blake3-verified, content-addressed, durable on the fs store), `ifc-lite layer publish --check` keeps the spec/report bytes in the local store, and the new `ifc-lite layer push` uploads a ref's stack (or one layer) plus its evidence to a registry.

- [#1732](https://github.com/LTplus-AG/ifc-lite/pull/1732) [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932) Thanks [@louistrue](https://github.com/louistrue)! - Registry webhooks + auto-merge (08-review.md §8.7, 10-registry.md §10.4): the registry emits HMAC-SHA256-signed events (layer pushed, ref moved/merged, review opened/updated/commented) to configured consumers, and `RefPolicy.autoMerge` merges conflict-free, all-checks-green candidates with a declared base unattended on push — fail-closed with `requireHumanApproval` and for baseless candidates.

- [#1729](https://github.com/LTplus-AG/ifc-lite/pull/1729) [`b54f704`](https://github.com/LTplus-AG/ifc-lite/commit/b54f70478a7b92055750f11267ffe7fa47ed7da1) Thanks [@louistrue](https://github.com/louistrue)! - Review comments as BCF topics (08-review.md §8.6): registry reviews gain `GET/POST /api/v1/reviews/:id/topics` — topics bound to (entity, componentKey?) with server-derived authors, optional viewpoints, and the named-reviewers write gate. The MCP review loop matches: new `add_review_topic` tool, and `get_review_feedback` returns the topics.

### Patch Changes

- [#1728](https://github.com/LTplus-AG/ifc-lite/pull/1728) [`e3b3c53`](https://github.com/LTplus-AG/ifc-lite/commit/e3b3c5316fcd845d531265c11e0fb86cf526e778) Thanks [@louistrue](https://github.com/louistrue)! - The registry merge route accepts edit-in-place resolutions (`{ path, component_key, choice: "edited", attributes }`), strictly validated, with the engine's edited-target rules surfaced as 400s. Completes the conflict-queue spec (08-review.md §8.3) alongside the viewer's new edit choice and bulk actions.

- Updated dependencies [[`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab), [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932)]:
  - @ifc-lite/collab@0.4.0
  - @ifc-lite/merge@0.3.0

## 0.3.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer registry v1 (10-registry.md):

  - **merge**: the ref-merge flow (fast-forward, three-way planning, ref-policy enforcement, unrelated-base refusal) moved into `@ifc-lite/merge` as store-agnostic `mergeIntoRef`/`resolveAncestor`/`checkRefPolicy` over a `LayerRefStore` interface — the CLI and the registry run one decision procedure.
  - **collab-server**: opt-in `layerRegistry` mounts `/api/v1/layers|refs|reviews` — push with a server-side blake3 integrity gate (id recomputed, provenance validated), pull by id, refs with policies (policy-protected refs move only through the merge endpoint, where required checks and approval rules run), and review (PR) objects. Authorization derives from the websocket `authenticate` hook like the blob route: one token scheme for sync, blobs, and the registry; writes require write capability.
  - **cli**: `layer merge` now delegates to the shared flow (behavior unchanged).

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/collab@0.3.0
  - @ifc-lite/merge@0.2.0

## 0.2.6

### Patch Changes

- [#1692](https://github.com/LTplus-AG/ifc-lite/pull/1692) [`4ef69e9`](https://github.com/LTplus-AG/ifc-lite/commit/4ef69e903def842a9d94cd656a5caa176dd344bb) Thanks [@louistrue](https://github.com/louistrue)! - Link-based multiuser collaboration plumbing (ports draft [#937](https://github.com/LTplus-AG/ifc-lite/issues/937)):

  - `@ifc-lite/collab`: STEP → IFCX room seeding (`seedFromStep`), entity placement
    helpers (`usd::xformop` read/write + baselines), shared annotation pins,
    multi-mesh geometry refs (`geomIds` with legacy `geomId` read fallback,
    `addGeometryRef`, `iterGeometries`), presence `role` field, and a browser fix
    for `HttpBlobStore` (bind global `fetch` to avoid "Illegal invocation").
  - `@ifc-lite/collab-server`: signed room tokens (HS256 mint / verify / revoke /
    kick endpoints + `createRoomTokenAuthenticator`), CORS for the HTTP routes,
    disk-backed `FsBlobStorage`, `Room.kickClient` / `RoomManager.peek`, and a CLI
    that wires token auth + disk blobs from `COLLAB_TOKEN_SECRET` /
    `COLLAB_DATA_DIR` (plus a reference Dockerfile + railway.toml).
  - `@ifc-lite/renderer`: `rotateMeshesForEntity/-Entities` — in-place yaw rotation
    of an entity's flat meshes about a pivot (local-frame-origin aware), used by
    live collab placement sync and the viewer's rotate action.

- Updated dependencies [[`4ef69e9`](https://github.com/LTplus-AG/ifc-lite/commit/4ef69e903def842a9d94cd656a5caa176dd344bb)]:
  - @ifc-lite/collab@0.2.7

## 0.2.5

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/collab@0.2.6

## 0.2.4

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/collab@0.2.5

## 0.2.3

### Patch Changes

- [#1501](https://github.com/LTplus-AG/ifc-lite/pull/1501) [`8a99208`](https://github.com/LTplus-AG/ifc-lite/commit/8a99208a4467e084ca5bf574201f5a4c2caa5f76) Thanks [@louistrue](https://github.com/louistrue)! - fix(collab-server): merge persisted update frames instead of byte-concatenating them

  Room logs store one Yjs update per `append`. Every persistence backend
  (`Memory`, `File`, `Redis`, `S3`) returned the frames byte-concatenated, and
  `loadFromDisk` fed that blob to `Y.applyUpdate`, which decodes only the first
  update and silently ignores the rest — so every edit after the first frame was
  lost on room reload (up to `compactEvery` updates between compactions). `load`
  now combines frames with `Y.mergeUpdates`.

  Also:

  - `FilePersistence` room ids are encoded with `encodeURIComponent` (reversible,
    collision-free, traversal-safe) instead of a lossy `[^a-zA-Z0-9._-] -> _`
    replace that mapped distinct rooms (e.g. `a/b` and `a:b`) onto one log file.
    Safe ids (UUIDs, room codes) are unchanged, so existing logs keep their names.
  - `JsonlFileAuditSink.append` no longer poisons its write chain: a single failed
    append previously left the shared promise rejected, so every subsequent append
    was skipped forever. Writes now run after the previous one settles regardless
    of outcome, while callers still observe their own error.

## 0.2.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/collab@0.2.3

## 0.2.1

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

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/collab@0.2.2

## 0.2.0

### Minor Changes

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Final integration batch. Closes the last cross-cutting items in the
  plan: the spec §16.3 mutations bridge, open problem #7 (per-section
  locks), the viewer-mount one-liner, the TLS bundle helper, and a
  runnable performance benchmark suite. **+11 tests, total 175 passing.**

  `@ifc-lite/collab`

  - **`bindMutationsToCollab(view, session, opts)`** (spec §16.3): wraps
    `@ifc-lite/mutations` `MutablePropertyView` so legacy STEP property
    edits mirror to the Y.Doc whenever a collab session is bound. The
    view's existing observers / change-set tracking still fire; reads
    pass through. `resolveEntity(id)` translates numeric expressIds to
    IFCX paths; returning `null` skips the mirror for that mutation.
    `PROPERTY_TYPE_NAMES` maps `PropertyValueType` enum values to the
    IFCX type strings stored on `PropertyValue`.
  - **`mountPresenceInViewer({ session, container, viewport })`** (spec
    §7 viewer mount): one-line glue that creates a presence overlay,
    forwards `mousemove → setCursor2d`, and returns a `teardown()`.
  - **`runPerfBenchmarks(budget?)`** (§15): self-contained Node-runnable
    benchmarks measuring single-attribute update size, cold-load time
    for a 1k-entity fixture, and (gated by `COLLAB_BENCH_HEAVY`) state-
    vector size at 100k entities. Each result reports
    `{ name, value, unit, budget, ok }`. Useful for `vitest` perf
    regression coverage and CI smoke tests.

  `@ifc-lite/collab-server`

  - **Per-section locks (open #7).** `createPathLockRegistry()` →
    `add({ prefix, label?, exemptUserIds?, exemptRoles? })` /
    `remove(lock)` / `matches(path, principal)` / `clear()`.
    `verifyAgainstPathLocks(registry)` returns a `VerifyMessageFn`
    that decodes incoming sync-update frames, runs them through a
    throwaway Y.Doc to harvest touched paths, and rejects writes that
    intersect any locked prefix (audit reason `locked:<label>`).
    `harvestUpdatePaths(update)` is exposed for tests + custom
    filtering. Path format: `entities/wall`, `geometry/g7`, etc.
  - **`startSecureCollabServer(opts)`**: bundles `createSecureHttpServer`
    - `secureHttpHandler` + `startCollabServer` so deployers get
      TLS-in-process plus the OWASP-baseline header wrapper without
      writing the wiring.

  Tests added (+11): mutations bridge happy path / null-resolve / delete
  mirror, path-lock registry add/match/remove + path harvesting + raw-WS
  rejection of writes to a locked prefix, perf benchmarks for
  single-attr-update / cold-load / runPerfBenchmarks happy paths,
  secure-bundle smoke test (rejects missing cert paths), viewer-bridge
  overlay mounting + mousemove forwarding + clean teardown via a
  hand-rolled DOM stub.

  Plan doc: v0.1 ☑ (mutations bridge added), v0.2 ☑ (mount-in-viewer
  shipped), v0.5 ☑ (TLS bundle + per-section locks). Open problems are
  closed in this batch as follows: problem #7 (per-section locks) is
  new in this PR; problems #1, #2, #3, #4, #5, #6, #8, #9, #10 were
  already closed in prior batches.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Big reach-for-the-stars batch. Closes (or near-closes) the remaining
  substantial items in `docs/architecture/collab-plan.md` for v0.2,
  v0.5, v0.7, and v1.0. **+21 tests, total 140 passing.**

  `@ifc-lite/collab`

  - **History sidecar (v0.7).** `HistorySidecar` interface with
    `MemoryHistorySidecar` ship and an `AutomergeHistorySidecar` slot
    reserved (matching the same interface). Records, time-travels, diffs
    per-entity-id, branches, merges. `attachHistorySidecar(session,
sidecar, opts)` drives a sidecar from a live `CollabSession` on a
    configurable interval + on demand, with optional differential
    layers in each entry for cheap diff queries.
  - **End-to-end encryption (v1.0).** WebCrypto-based suite:
    `deriveRoomKey` (PBKDF2-SHA256, 200k iterations default),
    `generateRoomKey` / `exportRoomKey` / `importRoomKey`,
    `encryptFrame` / `decryptFrame` with versioned
    `[1B ver][12B IV][N B AES-GCM]` framing, and a `KeyRing`
    (`createKeyRing(initial, { gracePeriodMs })`) so in-flight frames
    decode through retired keys for the configured grace window.
  - **Presence-renderer math (v0.2).** `peerVisuals(peers, opts)` turns
    a `PresenceMap` into render-ready `{ color, label, opacity,
isStale, cursor3d, cursor2d, selection, modelId }`. Color resolution
    uses `colorForUser` against either the human or agent palette
    depending on the `(agent)` suffix; opacity fades over `staleAfterMs`.
    `cursorScreenPosition` projects 2D cursors per viewport.

  `@ifc-lite/collab-server`

  - **S3 persistence (v0.5).** `S3Persistence` against an injectable
    `S3LikeClient` + `S3Commands` shape — AWS SDK, R2, MinIO, or any
    S3-compatible client all fit without forcing
    `@ifc-lite/collab-server` to depend on `@aws-sdk/client-s3`.
    Per-room layout: `<prefix><room>.snap` for compacted state plus
    `<prefix><room>.log/<NNNNNNNNNN>.bin` for rolling log frames.
    Implements load / append / compact / drop with `frameMaxBytes`
    enforcement.
  - **Anti-replay wired into the message path (v0.5 / open #8).**
    `RoomOptions.verifyMessage: VerifyMessageFn` runs before rate-limit
    / role-check. Rejects audit as `reject` with the supplied reason.
    `verifyWithReplayProtector(protector, { requireSigned })` adapts the
    existing `ReplayProtector` for the hook. `encodeSignedFrame` /
    `decodeSignedFrame` ship a default
    `[0xff][4B clientId][4B clock][64B HMAC][N B payload]` envelope so
    apps don't have to invent one.
  - **TLS / secure-server helpers (v0.5).** `createSecureHttpServer`
    with strong defaults (TLS 1.2+, conservative cipher list, ALPN
    `http/1.1`, optional CA bundle for mTLS), `applySecurityHeaders` for
    the OWASP-baseline response headers (HSTS, no-sniff, frame deny,
    no-referrer), and `secureHttpHandler(inner)` to wrap an existing
    request handler with the headers + TRACE/TRACK rejection.

  Tests added (+21):

  - `history` — record / list / time-trace, diff added/removed/changed,
    branch + merge, session-driven captures with diff entries.
  - `e2e-encryption` — derive → encrypt → decrypt round-trip,
    cross-salt rejection, wrong-key rejection, export/import preserves
    decryption, key ring grace period, post-grace key drop.
  - `render` — color/label/opacity resolution, stale fading, local-peer
    exclusion, cursor projection by viewport.
  - `replay-wired` — server rejects unsigned frames when
    `requireSigned`, signed frame decodes + clock-tracks, replay
    rejected.
  - `secure-server` — security headers applied, TRACE/TRACK rejected
    via raw socket (undici blocks TRACE client-side).
  - `persistence-s3` — append + load round-trip, compact replaces snap
    and clears log, drop removes everything.

  Plan doc has updated v0.2 / v0.5 / v0.7 / v1.0 status badges. v0.5
  and v0.7 and v1.0 are now ☑ on every item that lives inside these
  two packages; remaining work for v0.5 (Redis persistence,
  full-bucket histograms) and v0.7 (`AutomergeHistorySidecar`) is
  opt-in extension that doesn't block GA.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Tackle-everything batch. Closes the remaining substantial items in the
  plan for v0.2, v0.3, v0.4, v0.5, v0.7, and v1.0. **+37 tests, total
  164 passing.**

  `@ifc-lite/collab`

  - **`AutomergeHistorySidecar`** (v0.7): real `@automerge/automerge`
    3.x implementation. Same `HistorySidecar` interface as the in-memory
    variant; adds binary `save()` / `load(bytes)` for
    cross-restart persistence. Branches and merges round-trip through
    the Automerge doc.
  - **`buildBranchTree(sidecar)`** (v0.7): pure-data branch-tree
    builder. Returns `{ nodes, edges, branches }` with `branch-anchor` /
    `entry` / `merge` node kinds and `history` / `fork` / `merge` edge
    kinds. Apps render this directly into git-log columns or
    force-directed graphs.
  - **Parametric mesh primitives** (v0.3): pure-TS reference kernel.
    `paramsToMesh(source, params)` ships `extruded-area-solid`, `box`,
    `cylinder`, and `revolved-area-solid`. `hashMesh(mesh)` returns a
    32-hex content hash for cache keys.
  - **Determinism harness** (v0.3 / open #5):
    `runDeterminismHarness(kernel, fixtures, expected)` + a
    `DEFAULT_FIXTURES` set covering every primitive. CI runs this on
    every platform and fails on drift.
  - **`createWebRtcProvider`** (v0.2 §8.1): wraps `y-webrtc` lazily so
    consumers who don't use it pay no bundle cost. Same status /
    whenSynced shape as the websocket provider.
  - **`createNumericRegistryAdapter(registry)`** (v0.4): bridges the
    renderer's existing numeric-offset `FederationRegistry` into our
    string-shaped `FederationResolver` without forcing
    `@ifc-lite/collab` to depend on the renderer.
  - **`installIfc4ToIfc4x3Migration()`** (v1.0): sample registered
    schema migration that renames `Pset_<…>::<key>` attributes into
    the `bsi::ifc::v5a::Pset_<…>::<key>` namespace. Demonstrates the
    migration plumb for consumers.
  - **`createPresenceOverlay({ container, viewport })`** (v0.2): drop-in
    2D canvas overlay that consumes a `PresenceMap` and draws other
    peers' cursors + label badges. `update(peers)` redraws; auto-resizes
    via `ResizeObserver`. Pairs with `peerVisuals` for any DOM viewer.

  `@ifc-lite/collab-server`

  - **`RedisPersistence`** (v0.5): `Persistence` against a
    `RedisLikeClient` interface (ioredis / node-redis 4+ satisfy it).
    Layout: `<prefix><roomId>:snap` for compacted state, list
    `<prefix><roomId>:log` for rolling frames. Implements
    load / append / compact / drop.
  - **Bucketed histograms** (v0.5): `MetricsRegistry.bucketedHistogram(
name, buckets, help)` accumulates observations into upper-bound
    buckets and renders as a proper Prometheus `histogram` type with
    `le="<bound>"` bucket labels.

  Tests added (+37): Automerge sidecar record / save+load / diff /
  branch+merge; branch-tree anchor + history edges, fork edges, merge
  edges with merge-from-branch annotation; parametric primitives shapes

  - deterministic hashes + dispatch errors; determinism harness happy
    path + drift detection; numeric registry adapter forwarding + numeric
    guard; IFC4 → IFC4X3 sample migration verifying renames; Redis
    persistence append/load + compact/clear + drop; bucketed histograms
    counts + label dimensions + empty-bucket guard.

  Plan doc: v0.2 ☑ (overlay shipped), v0.3 ☑ (parametric kernel +
  determinism harness), v0.4 ☑ (numeric registry adapter), v0.5 ☑
  (Redis + bucket histograms), v0.7 ☑ (Automerge sidecar + branch
  tree). v1.0 was already ☑; the sample migration finishes the §1.x
  "actually IFC schema migrations" caveat.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - `@ifc-lite/collab` follow-up: deterministic per-user color hash exposed
  publicly (`colorForUser`, `DEFAULT_USER_PALETTE`, `fnv1a`) and consumed
  automatically by `Presence.setUser` when the caller doesn't supply a color.
  `UserIdentity.color` is now optional.

  Conflict detector tightened: only flags concurrent deletes (not creates) at
  the entity top level, and now also surfaces concurrent Pset-creation as a
  `pset-property` event keyed by Pset name.

  `@ifc-lite/collab-server` follow-up: an append-only audit log
  (`AuditSink`, `MemoryAuditSink`, `noopAuditSink`, `shortHash`) that records
  `(timestamp, user, room, op-type, op-hash)` for every connect, sync,
  update, awareness, and reject event; and a per-peer rate limiter
  (`createRateLimiter`, `RateLimitOptions`) wired into the room's update
  filter. Editor-or-better roles get a 200-token / 60-tps default bucket;
  `startCollabServer` accepts a function form so service accounts can have
  tighter budgets than humans.

  Tests added: 23 new (color, audit + rate limit, disconnect/reconnect,
  property-based convergence with seeded random traces, conflict scenarios
  for each `ConflictKind`, broader entity-op coverage). Total now 49.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - v0.1 Foundation of `@ifc-lite/collab` — real-time collaborative BIM via CRDT
  on IFCX, plus a reference websocket sync server. New packages.

  `@ifc-lite/collab` ships:

  - Y.Doc schema with `entities` / `relationships` / `geometry` top-level
    shared types and helpers for every operation in the spec §6 table
    (create, delete, set attribute, set Pset property, hierarchy move, type
    promotion, relationship target add/remove, geometry param/blob updates).
  - IFCX seed (`seedFromIfcx`) and snapshot (`snapshotToIfcx`) with full
    round-trip against the buildingSMART hello-wall fixture.
  - Per-user layer extraction filtered by `clientID`.
  - IndexedDB and websocket providers, plus an in-memory provider for tests.
  - Awareness / presence helpers (3D + 2D cursors, selection, camera, view,
    section, isolation, tool, status) at 30 Hz with stale eviction.
  - Y.UndoManager wrapper scoped to a local-origin tag, so a peer's `undo()`
    only rolls back their own edits.
  - Conflict detector backed by `Transaction.changed` (catches LWW losses
    even when `YEvent.keys` is empty).
  - `createCollabSession` glues the above into the public façade documented
    in spec §16.2.

  `@ifc-lite/collab-server` ships:

  - `y-websocket`-compatible sync (`y-protocols/sync` + awareness on the
    same socket).
  - In-memory and append-only-file persistence with periodic compaction.
  - JWT auth hook (`AuthenticateFn`) and role-based write capability check.
  - Healthcheck endpoint and clean shutdown.
  - `ifc-lite-collab-server` CLI binary.

  Tests cover schema round-trips, the buildingSMART hello-wall fixture,
  two-peer convergence with conflict-detector firing on both peers,
  end-to-end sync through the websocket server, undo isolation, and
  per-user layer extraction.

  See `docs/architecture/collab-plan.md` for the v0.1 → v1.0 roadmap.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the v0.1 → v1.0 plan. Lands foundational pieces of v0.3
  (geometry), v0.4 (federation), and v0.6 (MCP) so each upstack consumer
  has stable shapes to build on.

  `@ifc-lite/collab`

  - Blob store: content-addressed put/get/has/delete/list with a stable
    32-hex `fnv128` hasher. Backends: `MemoryBlobStore`,
    `createIndexedDbBlobStore` (browser only, lazy-loaded), `HttpBlobStore`,
    and `LayeredBlobStore(local, remote)` for local-first read-through and
    parallel write-through.
  - CSG-tree CRDT: `ensureCSGTree`, `appendCSGOp`, `insertCSGOp`,
    `removeCSGOp`, `moveCSGOp`, `getCSGOps`. Stored as `Y.Array<CSGOp>` on
    the geometry node's `params.ops` so concurrent appends interleave
    per-peer-relative-order. Order-dependence of the resulting solid is
    documented as a v0.1 limitation; full CRDT-tree merging is open
    problem #4 (v1.x).
  - Conflict UI bridge: `createConflictUIBridge(detector)` folds detector
    events into stable `(kind, path, field)` buckets and emits
    `open` / `update` / `close` lifecycle events. Buckets close on
    idle (`closeAfterMs`, default 4 s) or via explicit `resolve(key)`.
  - Agent presence helper: `markAsAgent`, `agentIdentityFromMcp`,
    `AGENT_PALETTE`. Standardized convention so the viewer can render MCP
    tool peers with a `(agent)` suffix and a distinct color band.
  - `FederationSession` (spec §10): hosts N per-model `CollabSession`s
    plus a shared `_federation` Y.Doc for cross-model
    `FederationRecord`s (clash, RFI, view, BCF refs). Presence is
    project-scoped via the `_federation` doc per §10.2. APIs:
    `createFederationSession`, `addModel`, `removeModel`, `upsertRecord`,
    `getRecord`, `removeRecord`, `listRecords`, `observeRecords`.

  `@ifc-lite/collab-server`

  - Blob HTTP route: `PUT /blobs/<hash>`, `GET /blobs/<hash>`,
    `HEAD /blobs/<hash>`, `DELETE /blobs/<hash>`, `GET /blobs` (list).
    Pluggable `ServerBlobStorage` (default `InMemoryBlobStorage`,
    swappable for S3/disk) and configurable `blobMaxBytes` (default
    100 MB) for payload-too-large rejection.

  Tests added (+22, now 71 total — all passing): blob store backends,
  CSG concurrent appends, UI-bridge open/update/close + explicit resolve,
  agent presence (suffix idempotence, deterministic id from MCP input),
  FederationSession (multi-model rooms, record CRUD, observeRecords), and
  the server's blob route end-to-end (round-trip, malformed-hash 400,
  413 on payload-too-large).

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands the production observability stack (v0.5),
  blob GC (v0.3 / open #6), GDPR helpers (v1.0), and the worker-safe
  snapshot entry point (v0.1 deferred).

  `@ifc-lite/collab-server`

  - `SnapshotWorker`: periodic per-room IFCX export to a writable
    directory. `runOnce()` for tests / cron. Skips idle rooms by default;
    `includeIdle: true` covers them too. Adds `@ifc-lite/collab` as a
    dep so we can call `snapshotToIfcx` directly.
  - `MetricsRegistry` + Prometheus-text `/metrics` endpoint. Ships
    counter/gauge/lightweight-histogram. Built dependency-free so we can
    swap in `prom-client` later without API churn. Surfaces
    `collab_rooms`, `collab_room_peers{room}`, `collab_updates_total`,
    `collab_rejects_total{reason}`.
  - `RoomManager.setCounters({ update, reject })` so the server can
    inject metric counters without leaking the registry into the manager.
  - `createReplayProtector({ secret })` (open problem #8): HMAC-SHA256
    verifier for `(clientId, clock, payload)` envelopes with strict
    monotonic-clock enforcement. `computeHmac` is exported so non-Node
    clients can produce matching tags.

  `@ifc-lite/collab`

  - `BlobStore.stat(hash)` (optional): returns `BlobMeta` without
    downloading the bytes. Implemented for `MemoryBlobStore`,
    `createIndexedDbBlobStore`, and `HttpBlobStore` (HEAD).
  - Blob GC (open problem #6): `collectReferencedBlobHashes(doc)`,
    `planBlobSweep(store, referenced, { epochMs })`, `sweepBlobs(store,
decision)`. Walks every entity's `geometryRef.geomId` → resolves
    `blobHash`, also collects any 32-hex string in `geometry.params.*`
    so apps that store auxiliary refs in params survive.
  - GDPR helpers: `exportAndLeave(session, { snapshot, serverDelete })`
    snapshots to IFCX, marks presence offline, runs the optional remote
    hard-delete hook, then disposes. `redactAuthorMeta(session)` blanks
    per-entity `createdBy` / `lastEditedBy` for anonymised exports.
  - Worker-safe snapshot entry: new sub-export
    `@ifc-lite/collab/snapshot/worker` ships `runSnapshotWorker(self)`,
    a postMessage adapter that mounts a `(snapshot|seed)` request handler
    on a `DedicatedWorkerGlobalScope`. The pure `snapshotToIfcx` /
    `seedFromIfcx` helpers are also re-exported from this entry point so
    consumers that don't want the adapter still get a worker-clean
    surface.

  Tests added (+18, total 101 passing): blob GC end-to-end (collect →
  plan → sweep, plus epoch grace window), GDPR `exportAndLeave` happy
  path / hook ok / hook failure / `redactAuthorMeta`, snapshot worker
  postMessage round-trip (snapshot, seed, error report), server-side
  `SnapshotWorker` writing IFCX files, metrics counters / gauges /
  histogram and the `/metrics` endpoint serving Prometheus text, and
  replay-protector HMAC happy path / tampered MAC / replay / payload
  mismatch.

  Plan doc updated with v0.3 / v0.5 / v1.0 status badges.

- [#616](https://github.com/louistrue/ifc-lite/pull/616) [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142) Thanks [@louistrue](https://github.com/louistrue)! - Continuing the plan. Lands operational v0.5 pieces, the v0.7 branching
  starter, and v1.0 schema-migration scaffolding.

  `@ifc-lite/collab-server`

  - `JsonlFileAuditSink`: append-only NDJSON file sink with size-based
    rotation (`rotateAtBytes`) and an opt-in `fsync`-after-append mode for
    durable audit trails.
  - Idle room unloading: `idleUnloadMs` knob plumbed end to end. The
    manager runs an internal `unref()`'d sweep timer at half the idle
    window; `sweepIdle()` is also callable directly. Persistence keeps the
    durable copy, so unloading is non-destructive.
  - Retention policy: `planRetention(dir, policy)` + `applyRetention`.
    Honors `fullLogDays` (default 90), `snapshotsDays` (default 5y), and
    `maxBytesPerRoom` (trim oldest first). Pluggable file classifier so
    custom naming schemes work too.
  - `RoomManager.stats()` returns `(roomId, peerCount, idleMs)` triples
    for diagnostics and tests.

  `@ifc-lite/collab`

  - Schema-version helpers (open problem #2 prep): `getSchemaVersion`,
    `setSchemaVersion`, `registerSchemaMigration`, `migrateSchema`, plus
    a `MIGRATION_ORIGIN` symbol so observers can filter migration
    transactions out of e.g. undo stacks.
  - v0.7 branching starter: `forkSession(parent, { name })` snapshots the
    parent's Y.Doc, seeds a fresh sibling session, and stamps
    `meta.branch.parentRoomId` / `branch.name` / `branch.forkedAt`.
    `mergeBranch(parent, branch, strategy)` implements both `'ops'`
    (Y-update apply with last-write-wins on conflicts) and `'layer'`
    (IFCX snapshot + non-resetting re-seed). Returns a small
    `MergeReport`. `readBranchMeta` exposes the metadata back.

  Tests added (+12, total 83 passing): JSONL append + rotation, retention
  plan + apply (full-log days, snapshots days, maxBytesPerRoom),
  RoomManager idle sweep with both empty and busy rooms, schema-version
  round-trip + a sample migration that renames an attribute namespace,
  and end-to-end branch fork → divergent edits → merge for both strategies
  including a non-conflicting parent-edit-survives case.

### Patch Changes

- Updated dependencies [[`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142), [`2fc15b4`](https://github.com/louistrue/ifc-lite/commit/2fc15b45fbd06ebb57120d87db9a0ab06ed18142)]:
  - @ifc-lite/collab@0.2.0

## 0.1.0

### Minor Changes

- Initial v0.2 scaffold: y-websocket-compatible sync, in-memory room registry,
  append-only file persistence, JWT auth hook, healthcheck.
