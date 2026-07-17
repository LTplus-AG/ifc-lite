# @ifc-lite/mcp

## 0.9.1

### Patch Changes

- [#1774](https://github.com/LTplus-AG/ifc-lite/pull/1774) [`8a0b09f`](https://github.com/LTplus-AG/ifc-lite/commit/8a0b09f161fffbc3302e173bd639a5aa85074e59) Thanks [@louistrue](https://github.com/louistrue)! - Harden the collab server, MCP path guard, and point-cloud decoders against abuse and hostile input.

  - collab-server: rate-limit the unauthenticated fresh-room token-mint path per client IP (authenticated admin re-mints are exempt) and cap `claimedRooms` growth (`COLLAB_MAX_CLAIMED_ROOMS`, default 100k). `X-Forwarded-For` is IGNORED by default when deriving the rate-limit IP (a spoofable header would hand every request its own bucket); set `COLLAB_TRUST_PROXY=1` (or `tokenEndpoint.trustForwardedFor`) behind a trusted reverse proxy, which then uses the LAST header entry (the hop the proxy itself appended).
  - collab-server: access-control persistence (revocations + claimed rooms) is now debounced, written atomically (temp file + rename, no torn state file on crash), and flushed on SIGINT/SIGTERM; `flush()` rejects (and the CLI exits non-zero, loudly) when the state never reached disk. Startup is fail-closed: a present-but-unreadable or malformed state file throws instead of running open, and a MISSING state file on a data dir that already has persisted rooms marks those rooms claimed (admins re-mint with their still-valid admin bearers; squatters cannot first-claim them). Revocations now persist as `jti -> exp` (the legacy `revoked: string[]` shape still loads) and are pruned once the revoked token would have expired anyway, so the deny-list stays bounded without ever evicting a live revocation. The policy moved from `bin.ts` into an exported `createAccessControl` for reuse and testing.
  - collab-server: a ref that requires human approval now refuses approvals when its reviewer allowlist is empty (previously any non-author principal could self-approve past the merge gate).
  - collab-server: metrics-token comparison hashes both sides to fixed-length digests before `timingSafeEqual`, removing the length oracle; startup without `COLLAB_TOKEN_SECRET` on a non-loopback host logs an explicit OPEN-server warning; idle rooms unload after `COLLAB_IDLE_UNLOAD_MS` (default 5 min) so long-lived deployments can't wedge at `maxRooms`.
  - mcp: the safe-path guard now also refuses shell startup/persistence files (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, …) and the `~/.config` tree for both read and write.
  - pointcloud: E57/PCD/PLY decoders reject header-declared record/point/vertex counts (and LZF uncompressed sizes) that the actual body bytes cannot back, so a small hostile file can no longer force multi-GB allocations before the first read fails; ascii floors allow EOF-terminated final records. The PCD LZF expansion bound is format-derived (90x, above LZF's real 88x back-reference maximum, so genuinely repetitive valid files decode) plus an absolute 1 GiB uncompressed ceiling; PCD field SIZE/COUNT must be positive safe integers and the accumulated stride may not overflow. PLY element counts are parsed strictly, and list-valued properties on the vertex element (variable-length records the fixed-stride readers cannot walk) are rejected up front.

- Updated dependencies [[`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`7ef3622`](https://github.com/LTplus-AG/ifc-lite/commit/7ef36225d863ec64dfb254cf0767d4ab9d034849), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`a42b8a9`](https://github.com/LTplus-AG/ifc-lite/commit/a42b8a9cfc559781575dde893b2116a5dc493732)]:
  - @ifc-lite/bcf@1.16.3
  - @ifc-lite/parser@3.9.1
  - @ifc-lite/data@2.6.0
  - @ifc-lite/export@2.5.3
  - @ifc-lite/geometry@3.2.1
  - @ifc-lite/ids@1.15.32

## 0.9.0

### Minor Changes

- [#1729](https://github.com/LTplus-AG/ifc-lite/pull/1729) [`b54f704`](https://github.com/LTplus-AG/ifc-lite/commit/b54f70478a7b92055750f11267ffe7fa47ed7da1) Thanks [@louistrue](https://github.com/louistrue)! - Review comments as BCF topics (08-review.md §8.6): registry reviews gain `GET/POST /api/v1/reviews/:id/topics` — topics bound to (entity, componentKey?) with server-derived authors, optional viewpoints, and the named-reviewers write gate. The MCP review loop matches: new `add_review_topic` tool, and `get_review_feedback` returns the topics.

### Patch Changes

- Updated dependencies [[`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab), [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932), [`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483)]:
  - @ifc-lite/collab@0.4.0
  - @ifc-lite/merge@0.3.0
  - @ifc-lite/mutations@1.20.0

## 0.8.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs surfaces:

  - **cli**: new `layer` namespace (`create`, `status`, `publish`, `diff`, `merge --preview`, `log`, `bake`, `revert`, `rebase`) and `ref` namespace (`list`, `create`, `move`, `protect`) over a local content-addressed layer store, with stable exit codes (0 clean, 2 conflicts, 3 required-check/policy failure, 4 scope violation).
  - **mcp**: draft-layer tool family — `create_draft_layer`, `draft_apply_ops` (write-time scope enforcement), `publish_layer` (publish-time claim-vs-ops verification), `diff_layer`, `dry_run_merge`, `list_conflicts`, `request_review`, `add_review_feedback`, `get_review_feedback`, `respond_to_review`.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer store and merge hardening:

  - **cli**: `loadLayer` verifies the blake3 content address on every read (a tampered or corrupted layer file fails loudly instead of composing silently); refs.json, layer files, and draft.json are written atomically (temp file + rename); `layer publish --check <spec.ids>=<report.json>` stamps verified check evidence into the provenance manifest — pass/fail derived from the `ifc-lite ids --json` report, spec and report content-addressed; `layer merge` refuses a candidate whose declared base matches nothing on the target ref (exit 5) unless `--allow-unrelated` is passed.
  - **mcp**: `diff_layer`, `dry_run_merge`, and `list_conflicts` report `base_resolved` so agents can tell when a preview ran against an empty ancestor (the placeholder `would_fail_checks` field is gone).

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Session-scoped layer workspaces and ownership checks ([#1030](https://github.com/LTplus-AG/ifc-lite/issues/1030)): layer drafts are keyed by transport session id (private per Streamable HTTP session, disposed on session end; stdio keeps the local draft space) while published layers, refs, and reviews are process-shared so reviewers can act on them from their own sessions. `ToolContext` carries a `SessionIdentity`, drafts/reviews record their creating principal, mutating layer tools are owner-gated (reviews also visible to listed reviewers), and unknown-id error details only enumerate ids visible to the caller. `HttpTransport` enforces the same scope identity on DELETE/SSE-attach as on POST and rejects session factories that don't bind the provided session id; both in-repo factories (`@ifc-lite/mcp` CLI and `ifc-lite mcp`) bind it.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline ([#1031](https://github.com/LTplus-AG/ifc-lite/issues/1031)): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers. The typed `TypedPropertyValue` record is the canonical wire shape: the MCP `set_property` draft op emits it, property extraction decodes it (and skips `ifclite::` carriers), composition resolves `null` attribute opinions as removals, and `bakeLayers` preserves the persistent carriers while stripping bookkeeping.

### Patch Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - The layer-diff JSON is now one shared contract: `diffStackStates`/`diffLayerStacks` (`StackDiff` shape, deterministically ordered) live in `@ifc-lite/merge`, and the CLI `layer diff` command and the MCP `diff_layer` tool consume the identical implementation — the two previously separate copies had already drifted on ordering. A byte-exact contract test pins the wire shape the review UI will consume.

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/extensions@0.4.0
  - @ifc-lite/mutations@1.19.0
  - @ifc-lite/collab@0.3.0
  - @ifc-lite/merge@0.2.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/clash@1.6.3
  - @ifc-lite/parser@3.8.5
  - @ifc-lite/viewer-core@0.2.10
  - @ifc-lite/ids@1.15.30

## 0.7.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`3267aaf`](https://github.com/LTplus-AG/ifc-lite/commit/3267aaf5dfe98f9550695d44c1d12644f2c04b88), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/bcf@1.16.2
  - @ifc-lite/clash@1.6.2
  - @ifc-lite/create@1.16.4
  - @ifc-lite/data@2.5.2
  - @ifc-lite/export@2.5.2
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/ids@1.15.27
  - @ifc-lite/mutations@1.18.1
  - @ifc-lite/parser@3.8.2
  - @ifc-lite/query@1.14.13
  - @ifc-lite/sdk@1.21.2
  - @ifc-lite/viewer-core@0.2.9

## 0.7.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/bcf@1.16.1
  - @ifc-lite/clash@1.6.1
  - @ifc-lite/create@1.16.3
  - @ifc-lite/data@2.5.1
  - @ifc-lite/export@2.5.1
  - @ifc-lite/ids@1.15.26
  - @ifc-lite/parser@3.8.1
  - @ifc-lite/query@1.14.12
  - @ifc-lite/sdk@1.21.1
  - @ifc-lite/viewer-core@0.2.8

## 0.7.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - Plumb the IFC measure type through the property pipeline so consumers can show units (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)):

  - `@ifc-lite/data`: `Property` gains an optional `dataType?: string` carrying the raw IFC measure value type (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) of a typed nominal value. Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/mutations`: the `PropertyExtractor` function type now carries the same optional `dataType?` per property, and `MutablePropertyView.getForEntity` preserves it through the base and mutation-merge paths, so a property's measure type survives the merge for unit display.
  - `@ifc-lite/mcp`: `geometry_volume` / `geometry_area` now resolve the volume/area symbol from the file's declared `IfcUnitAssignment` (via `@ifc-lite/parser`'s `extractProjectUnits`) instead of hardcoding `m³` / `m²`, and report the resolved symbol in a new `unit` response field. Falls back to the SI default when the store has no source buffer or declares no such unit.

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/parser@3.7.0
  - @ifc-lite/data@2.4.0
  - @ifc-lite/mutations@1.18.0
  - @ifc-lite/ids@1.15.24

## 0.6.0

### Minor Changes

- [#1497](https://github.com/LTplus-AG/ifc-lite/pull/1497) [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(parser): support opening `.ifcZIP` containers (issue [#1494](https://github.com/LTplus-AG/ifc-lite/issues/1494))

  The buildingSMART IFC container format — a zip archive wrapping a single
  `.ifc`/`.ifcxml` file — is now unwrapped transparently. New `@ifc-lite/parser`
  exports:

  - `isZipBuffer(buffer)` — cheap magic-byte check.
  - `unwrapIfcZip(buffer)` — returns the model file's bytes if `buffer` is a
    zip container, or `buffer` unchanged otherwise (safe to call
    unconditionally on every load). Throws if the archive has zero or more
    than one `.ifc`/`.ifcxml` entry rather than guessing which to load, or if
    the entry's declared uncompressed size exceeds 4 GiB (a zip-bomb guard,
    checked from the zip central directory — no decompression needed to check).
  - `unwrapIfcZipView(view)` — same contract for a Node `Buffer`/`Uint8Array`.

  `parseAuto` calls it automatically. The CLI and MCP loaders (`loadIfcFile`,
  `loadIfcModel`) unwrap before their STEP-signature check, so `ifc-lite info
model.ifcZIP` and MCP's `model_load` just work. The viewer's file picker and
  drag-and-drop now accept `.ifczip` alongside `.ifc`/`.ifcx`/`.glb`.

  The hosted Rust parsing server (`apps/server`) unwraps `.ifcZIP` too, in its
  multipart `extract_file` path (alongside the existing gzip handling), so an
  uploaded container is decompressed server-side before parsing and the viewer's
  multi-core server fast-path works for zipped uploads. It applies the same
  single-`.ifc`/`.ifcxml`-entry rule and bounds the decompressed size against the
  server's max-file-size ceiling (zip-bomb guard).

  Referenced resources inside the container (textures, documents) are not
  extracted in this pass — only the model file's bytes.

### Patch Changes

- Updated dependencies [[`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee), [`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`47bde10`](https://github.com/LTplus-AG/ifc-lite/commit/47bde10dcacddf8f99e1e6b2bf036c78c192c5ff), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/clash@1.5.0
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/export@2.5.0
  - @ifc-lite/ids@1.15.23

## 0.5.0

### Minor Changes

- [#1491](https://github.com/LTplus-AG/ifc-lite/pull/1491) [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53) Thanks [@louistrue](https://github.com/louistrue)! - feat(export): large-model GLB reliability - bounded memory, fail-closed, byte returns

  Three related hardening changes on the export surface:

  - **Bounded-memory GLB.** Inputs at or above 64 MB (native override
    `IFC_LITE_GLB_STREAM_THRESHOLD_MB`, `0` disables) are exported through a
    two-pass streaming assembler: pass 1 records per-mesh metadata only, pass 2
    re-streams and bakes vertex bytes directly into an exactly-preallocated GLB.
    Peak memory is the final artifact plus one mesh batch instead of the whole
    model's meshes plus multiple full-buffer copies - this fixes the wasm
    `RuntimeError: unreachable` / OOM on large in-browser exports. Models without
    instanceable groups produce byte-identical output; instanced models keep
    identical world geometry (rep-identity instancing is skipped above the
    threshold, content-hash dedup is kept).

  - **Fail-closed empty GLB at the boundary.** `exportGlb` now throws a typed
    `Error` whose message starts with `NO_RENDER_GEOMETRY` when the visible mesh
    set is empty, instead of returning a structurally valid but empty GLB.
    `@ifc-lite/geometry` exports `NO_RENDER_GEOMETRY` and
    `isNoRenderGeometryError(err)` to match it; the CLI and MCP map it to their
    existing tailored messages.

  - **BREAKING: sibling exporters return bytes.** `exportObj`, `exportCsv`,
    `exportJson`, `exportJsonld`, `exportIfcx`, `exportStep`, `exportMerged` and
    `exportHbjson` (wasm boundary, `IfcLiteBridge`, and `GeometryProcessor`) now
    return `Uint8Array` (UTF-8) instead of `string`, so output is no longer capped
    by the V8 max-string ceiling (~512 MB) - the same escape GLB already had.
    Decode with `TextDecoder` where a string is genuinely needed; file writers
    should write the bytes directly.

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c), [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/data@2.3.0
  - @ifc-lite/query@1.14.11
  - @ifc-lite/export@2.4.0
  - @ifc-lite/clash@1.4.1
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/viewer-core@0.2.7
  - @ifc-lite/ids@1.15.22

## 0.4.1

### Patch Changes

- 24e1648: Make the Rust-backed exporters reliable on large and degenerate inputs.

  Remove the ~512 MB input cap on GLB/glTF (and the sibling OBJ, CSV, JSON, JSON-LD,
  STEP, IFCX, HBJSON exporters). They decoded the entire input IFC byte buffer into a
  single JS string via `safeUtf8Decode` before crossing into WASM, where the binding
  immediately turned it back into bytes (`content.as_bytes()`). For an input over V8's
  `0x1fffffe8` (~512 MB) string ceiling that decode threw "Cannot create a string longer
  than 0x1fffffe8 characters", so files in the 0.5 GB+ range failed before any geometry
  ran. The boundary now passes the raw `Uint8Array`/`&[u8]` straight through (matching the
  existing `exportMerged` path), which removes the cap, drops a redundant full-buffer copy
  and a UTF-8 re-encode, and is byte-faithful for non-UTF-8 input.

  Scope: this lifts the cap on the INPUT side for all exporters. GLB returns a
  `Uint8Array`, so its output also escapes the V8 ceiling; the string-returning
  exporters (OBJ/CSV/JSON/JSON-LD/STEP/IFCX/HBJSON) still cap their serialized OUTPUT
  at the same ~512 MB string limit. In-browser, the wasm32 linear-memory heap (not the
  string cap) is the practical ceiling for the very largest models.

  Fail loud on an empty GLB export. A malformed-but-parseable model (or a filter whose
  matched entities carry no triangulated geometry) produced a structurally valid GLB with
  zero meshes, which the CLI and MCP tools wrote to disk and reported as success. Both now
  reject a zero-mesh GLB with a clear error (new `countGlbMeshes` helper in
  `@ifc-lite/export`).

  Guard the GLB assembler against the glTF 32-bit buffer limit. The assembler cast every
  buffer offset and byteLength `as u32`; past 4 GiB those casts silently wrapped (release
  builds disable overflow checks) and emitted a corrupt GLB. It now sums the binary buffer
  length in `usize` and asserts the 4 GiB ceiling with a clear message instead of wrapping.

- 7c45192: Instance repeated geometry in GLB/glTF export (50-85% smaller on repetitive models).

  The from-bytes GLB assembler baked every element occurrence in full, so a model with
  hundreds of identical windows, doors, or steel parts (one IFC `RepresentationMap`
  referenced by many `IfcMappedItem`s) emitted that geometry hundreds of times. The
  exporter now reuses the same representation-identity collation the GPU/native
  instancing path uses: each repeated shape is emitted ONCE and every occurrence is
  placed with a glTF node matrix carrying its world pose.

  Each occurrence's node matrix is recomputed in f64 from the per-occurrence world
  placement, the model RTC / site-local offset the baker subtracted, and the Z-up to Y-up
  basis change, then folded against the model-wide scene centre before the single f32
  downcast. Doing the relative transform in the post-RTC baked frame (not the placement's
  pre-RTC frame) is what keeps a ROTATED occurrence correct under a non-zero site/georef
  offset — otherwise it is mis-translated by `(R - I) * rtc`, kilometres at national-grid
  coordinates. The f64 composition keeps the absolute-magnitude terms cancelling to a
  model-relative, f32-precise translation even at national-grid scale.

  Only exact-bit groups are instanced (the template's local geometry IS each occurrence's),
  so the exported per-occurrence geometry is byte-faithful; rigid-tier and any
  singular-placement groups fall back to the flat path. Two round-trip tests reconstruct
  every instanced occurrence's world geometry from `root.translation * node.matrix *
template_local` and match the baked geometry to under a millimetre — one on a real model,
  one synthetic with a rotated instance at national-grid coordinates.

  Non-instanced occurrences keep the existing self-contained `world - scene_center` vertex
  bake (no node transform), so a consumer that ignores node transforms still sees them
  correctly placed. The flat remainder is additionally content-hash deduped (byte-identical
  baked meshes share one mesh placed by a node translation), so the output never regresses
  below the prior per-occurrence baseline on models without representation-level repeats.

  Measured GLB size: C20-Institute 4.0 -> 1.3 MB (-68%), AC20-Smiley 13.0 -> 2.4 MB (-82%),
  schependomlaan 15.5 -> 7.6 MB (-51%); models with no repeats are unchanged. Output is
  byte-deterministic. The viewer's from-meshes GLB path is unaffected (it carries no
  instancing side-channel and falls back to the flat content-hash dedup).

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [775e479]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0
  - @ifc-lite/export@2.3.0

## 0.4.0

### Minor Changes

- [#1242](https://github.com/LTplus-AG/ifc-lite/pull/1242) [`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722) Thanks [@louistrue](https://github.com/louistrue)! - Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
  source of truth for Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
  native-only ara3d BOS/Parquet path). They are exposed via wasm
  (`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
  reachable from TypeScript through `GeometryProcessor.export*` and
  `IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
  emits it as a node translation, keeping f32 vertex precision at georef scale).

  STEP export also supports schema conversion (`IFC2X3`/`IFC4`/`IFC4X3`/`IFC5` entity-type
  renames + attribute trimming) and a mutation bridge — `exportStep` takes a `mutations_json`
  payload (`MutablePropertyView` attribute edits + property-set synthesis: new
  `IfcPropertySingleValue`/`IfcPropertySet`/`IfcRelDefinesByProperties` entities). New Rust exporters:
  **IFC5/IFCX** (`exportIfcx` — USD-style node graph: spatial hierarchy + classes + known
  IFC5 properties) and **Merged** (`exportMerged` — combine several models into one STEP,
  id-offset + project unification).

  The CLI `export` command gains `--format obj|gltf|glb|jsonld|step|ifcx` (Rust-backed;
  `--type`/`--storey`/`--where`/`--limit` act as the isolation set — for `step` the forward
  `#`-reference closure is added so a filtered export never dangles a reference; `--schema`
  converts entity types). The MCP `export_glb` tool is unstubbed, `export_ifcx` is unstubbed,
  and a new `export_obj` tool is added (all honour an optional `type` filter).

  Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
  the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
  strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
  headless `clash`/geometry commands that previously failed to initialize wasm in Node.

  The viewer's GLB export now assembles the binary in Rust over the meshes it already
  holds (`GeometryProcessor.exportGlbFromMeshes`, wasm `exportGlbFromMeshes`) instead of the
  TypeScript GLTFExporter — no re-meshing, and the per-element RTC origin rides a glTF node
  translation so georef-scale models keep vertex precision.

  **BREAKING (`@ifc-lite/export`):** `GLTFExporter`, `JSONLDExporter`, and `CSVExporter`
  (+ their option types) are removed — glTF/GLB, JSON-LD, and CSV are now produced in Rust. Use
  `GeometryProcessor.exportGlb` / `exportGlbFromMeshes`, `exportJsonld`, and
  `exportCsv(bytes, mode, …)` (mode ∈ `entities`|`properties`|`quantities`|`spatial`). All in-repo
  callers (viewer GLB / command-palette / mobile / location-map / main-toolbar CSV exports, LOD1
  generator) are migrated; the Rust CSV gained the spatial-hierarchy mode to match.

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/geometry@2.9.0
  - @ifc-lite/export@2.0.0
  - @ifc-lite/sdk@1.20.1

## 0.3.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/create@1.16.2
  - @ifc-lite/export@1.19.6
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1
  - @ifc-lite/clash@1.1.3
  - @ifc-lite/sdk@1.18.3
  - @ifc-lite/data@2.0.3
  - @ifc-lite/ids@1.15.10

## 0.3.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc), [`8d5bd67`](https://github.com/LTplus-AG/ifc-lite/commit/8d5bd6701dc9962c2de5e42a7462008b2b8c2885)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/clash@1.1.2
  - @ifc-lite/create@1.16.1
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/export@1.19.5
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/ids@1.15.6
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/sdk@1.18.1
  - @ifc-lite/viewer-core@0.2.6

## 0.3.1

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

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/export@1.19.4
  - @ifc-lite/viewer-core@0.2.5
  - @ifc-lite/data@2.0.1
  - @ifc-lite/sdk@1.17.1
  - @ifc-lite/clash@1.1.1
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/ids@1.15.5

## 0.3.0

### Minor Changes

- [#891](https://github.com/LTplus-AG/ifc-lite/pull/891) [`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8) Thanks [@louistrue](https://github.com/louistrue)! - Add representation-agnostic clash detection.

  `@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
  adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
  clearance / touch classification) with a pluggable TS reference kernel and a
  Rust/WASM kernel kept in lockstep by a differential test. Results group into a
  _manageable_ set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
  framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

  Surfaced through the existing tools:

  - `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
    runnable rules from any preset list (the discipline matrix is this over the built-ins),
    so hosts can run a user-curated rule set.
  - `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
    presets, A/B highlight + camera framing, configurable settings & custom rules, a
    controllable BCF export with optional rendered snapshots).
  - `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
  - `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
    `--clearance`, `--bcf`.
  - `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
    and `clash_matrix`.

  The discipline matrix now threads a `clearance` value onto its rules, so
  `--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
  violations instead of silently dropping the override.

### Patch Changes

- Updated dependencies [[`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8)]:
  - @ifc-lite/clash@1.1.0
  - @ifc-lite/sdk@1.17.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/data@2.0.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/query@1.14.8
  - @ifc-lite/sdk@1.16.1
  - @ifc-lite/viewer-core@0.2.4
  - @ifc-lite/mutations@1.15.1

## 0.2.0

### Minor Changes

- [#615](https://github.com/louistrue/ifc-lite/pull/615) [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/mcp` — Model Context Protocol server for ifc-lite, exposing
  the BIM runtime to any MCP-aware LLM agent (Claude Desktop, Cursor,
  ChatGPT, Goose, Windsurf, Zed, custom). v0.1 ships with stdio + Streamable
  HTTP transports, scope-gated tool surface across discovery / query /
  geometry / validation (IDS + audit) / mutation / BCF / bSDD / diff /
  export / viewer, an `ifc-lite://` resource scheme, eleven pre-baked
  prompt templates, and an `ifc-lite mcp` CLI subcommand.

  The 3D viewer is a first-class workflow:
  • `viewer_open` boots the WebGL viewer in-process and swaps streaming
  adapters into the headless backend so every `bim.viewer.*` /
  `bim.visibility.*` call drives the live scene.
  • `viewer_colorize`, `viewer_isolate`, `viewer_fly_to`,
  `viewer_color_by_property`, `viewer_set_section` make agent-driven
  visualization a single tool call.
  • User picks in the browser flow back to MCP via SSE and surface as
  `notifications/resources/updated` on `ifc-lite://viewer/selection`.
  `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection`
  blocks until the next click.
  • `viewer_ask` emits agent-friendly wording so the agent can request
  user permission before opening a browser tab.
  • CLI flags `--viewer`, `--viewer-port`, and `--open` automate startup.

### Patch Changes

- Updated dependencies [[`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d)]:
  - @ifc-lite/ids@1.14.11
