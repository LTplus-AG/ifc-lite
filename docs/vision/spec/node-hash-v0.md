# Node-hash v0 (FROZEN 2026-07-25)

> **FROZEN.**
>
> - **Spec version:** `node-hash-v0` / **1.0.0**
> - **Freeze date:** 2026-07-25 (an explicit human act per the ABI-freeze rule,
>   `docs/vision/moonshots-execution-plan.md` §6 — performed by Louis by merging the freeze PR)
> - **Change policy:** the wire format defined in this document — the byte encodings in §3, the
>   tagged-hash string forms, the `NHV0` header, the kind tags, the sort rules, and the Merkle
>   rule in §3.5 — may no longer change. Any wire-format change, however small, requires a **new
>   versioned spec file** (`node-hash-v1.md`, with a new magic/version byte) and a **major
>   version bump of `@ifc-lite/provenance`**. Bug-for-bug behavior of the frozen encoding is the
>   contract; golden wire-format vectors in `packages/provenance/test/golden/` pin it in CI.
> - **Additive reserved fields** (already specified, additive-only, do not alter any hash):
>   - `Certificate.signatures?: {alg: 'ed25519', key, sig}[]` — reserved per §6 Q5 (decision
>     2026-07-24), ignored by v0 verification; actual signing lands with M4. Two normative
>     constraints on that landing:
>     1. **v0 defines no canonical certificate byte encoding.** The frozen format below covers
>        *node* hashes only — there is no specified, reproducible byte stream for a `Certificate`
>        itself, and therefore **nothing well-defined for M4 to sign over**. Defining that encoding
>        is part of the signing work, not a detail M4 can assume it inherits; until it exists, a
>        `signatures` array is decoration, and any claim that a v0 certificate is "signed" is
>        unbacked. v0 verification consequently ignores the field entirely, and `createCertificate`
>        only enforces its *shape* (one reserved algorithm, `ed25519`; non-empty `key` and `sig`)
>        so the slot M4 inherits is either absent or well-formed.
>     2. **M4 must mint a NEW version string and must never sign under `node-hash-v0`.** A signed
>        certificate is a different security artifact from an unsigned one: today the only thing
>        separating "signature-bearing" from "signature-ignoring" is the exact match on
>        `version === 'node-hash-v0'`, so signing under the v0 string would leave verifiers that
>        legitimately ignore signatures indistinguishable from verifiers that check them — a
>        downgrade with no wire-visible signal. The M4 version string (and its certificate byte
>        encoding) is introduced alongside the signing scheme; v0 keeps ignoring the reserved field
>        forever.
>   - `GeometryMeshPayload.semanticHash?` — the RTC-invariant annotation per §6 Q2, deliberately
>     NOT folded into the node hash (pinned by test).
> - **Scope: this freeze covers the node-hash wire format only.** The commutation certificate
>   (`commutation-v0`, `packages/provenance/src/commutation.ts`) is a *separate* artifact — a
>   merge-model / epsilon / op-set schema layered on top of node hashes — with its **own version
>   string and its own change rule**: it may advance to `commutation-v1` independently, without
>   requiring node-hash-v1 and without a wire-format change here. The reverse also holds: a
>   node-hash-v1 does not by itself rev the commutation schema. Each format's version pin is
>   asserted separately in `packages/provenance/test/frozen-surface.test.ts`.
>
> The five design questions in §6 (now an appendix) were all resolved by Louis on 2026-07-24;
> this freeze locks the format that implements those decisions.

Bet B0.1 (`docs/vision/moonshots-execution-plan.md` line 232) toward M1 "Proof-carrying
buildings" (`docs/vision/moonshots-tech.md` §M1). Unifies the repo's existing hash systems into
one canonical node-hash spec so a certificate can claim, and a verifier can check, "this subtree
did not change" across the whole building DAG (mesh → property set → relationship → layer →
element).

Status 2026-07-25: FROZEN. The five §6 questions were decided by Louis on 2026-07-24 (decisions
recorded inline below and in §6); the prototype implements them; the v0 format was frozen on
2026-07-25 under the change policy in the header block above.

## 0. Why unify, and why now

Four hash systems already exist in this repo, built independently for different jobs, and they
disagree on algorithm, byte order, and invariants:

| # | System | File | Algorithm | Invariance |
|---|--------|------|-----------|------------|
| 1 | Mesh determinism manifest (CI-pinned) | `rust/processing/src/determinism.rs` | FNV-1a64, 3 sub-hashes per mesh | **Byte-exact.** Same kernel build, same bits, or it fails CI. |
| 2 | Collab geometry blob store | `packages/collab/src/geometry/blob-store.ts` | `fnv128` — 4-lane 32-bit FNV-1a-ish, 32 hex chars | Byte-exact over opaque blob content (CRDT payload, not IFC semantics). |
| 3 | Diff engine geometry fingerprint | `rust/geometry/src/geom_hash.rs`, surfaced via `packages/diff` | splitmix64-mixed, per-triangle, quantized | **RTC-invariant, order/winding-invariant, translation-sensitive.** Deliberately loses byte-exactness to gain semantic stability. |
| 4 | IFCX layer content-addressing | `packages/ifcx/src/canonical.ts` (`computeLayerId`) | blake3 over canonical JSON | Byte-exact over canonicalized (sorted-key, NFC, no-whitespace) document text. |

(#4 was not one of the three systems named in the B0.1 brief, but it directly collides with this
spec's "layer" node kind — `computeLayerId` already IS a layer-level content hash in production
use by `packages/merge`. Leaving it out would mean inventing a fifth system instead of unifying
four. See §6 Q1.)

None of these should be thrown away — each is tuned for its job (CI bit-exactness, blob dedup,
human-meaningful diffing, layer content-addressing) and changing any of them is out of scope
here. What v0 adds is a **fifth, composing layer**: a canonical way to identify any node in the
building DAG by a hash of its content plus its children's hashes, anchored to the *existing*
byte-exact systems at the leaves (mesh, layer) rather than re-deriving mesh bytes from scratch.

## 1. Inventory (Step 1 findings)

### 1a. Mesh determinism manifest — `rust/processing/src/determinism.rs`

`compute_mesh_manifest()` (`determinism.rs:298-379`) runs the full pipeline over a pinned
synthetic fixture (`FIXTURE_IFC`, `determinism.rs:50-145`) and hashes the wire output with
FNV-1a64 (offset basis `0xcbf2_9ce4_8422_2325`, prime `0x0000_0100_0000_01b3`,
`determinism.rs:147-148`). Per mesh (`determinism.rs:313-343`), **three independent hashes**:

- `positions_hash` — FNV-1a64 over every position `f32`'s **little-endian bit pattern**
  (`v.to_bits().to_le_bytes()`, via `fnv1a_f32_bits`, `determinism.rs:163-167,316`). Asserted
  byte-identical on x86_64/aarch64/wasm32.
- `normals_hash` — same encoding, over normals (`determinism.rs:318-319`). The *only* per-mesh
  surface allowed to differ across targets (documented libm sin/cos trig gap on the curved
  column mesh, `determinism.rs:184-188`).
- `indices_origin_hash` — FNV-1a64 over, **in this exact order**: `express_id` as `u32`
  little-endian (`determinism.rs:322`), `geometry_class` as a single `u8` byte
  (`determinism.rs:323`), every index as `u32` little-endian (`fnv1a_u32s`,
  `determinism.rs:157-161,324`), then the 3-component `origin` as `f64` little-endian bit pattern,
  one component at a time (`determinism.rs:325-327`).

A per-mesh **fold**: starting from the offset basis, FNV-1a64 the three sub-hashes' own
little-endian bytes in order `hp, hn, hio` into a running `top` (`determinism.rs:329-331`); this
repeats across every mesh **in emit order**, then folds in three more labelled sub-hashes over
sorted flat wire arrays (`voids`, `material_colors`, `styles` — `determinism.rs:345-364`). The
final `top` is the pinned `hash` field in `rust/processing/tests/manifests/mesh_determinism.json`
(`0x7ed14cac8281eda1` today, asserted on native x86_64/aarch64 and its wasm32 pair — see the
per-mesh table at `mesh_determinism.json:12-67`, e.g. mesh `#100`:
`positions_hash: 0xf7644f11ac208315`).

**What this buys**: a bit-for-bit reproducibility proof for one kernel build. It says nothing
about whether two *different* kernel versions (or the same version with different f32 rounding
under LTO) would agree — that's the trust-root problem in §4.

### 1b. Collab geometry blob store — `packages/collab/src/geometry/blob-store.ts`

`fnv128` (`blob-store.ts:56-68`) hashes arbitrary blob `bytes` (opaque — could be a serialized
mesh, a parametric param blob, anything the CRDT layer stores) with **4 independent 32-bit
lanes**, seeded `[0x811c9dc5, 0x84222325, 0xcbf29ce4, 0x100000001]`. Per byte, per lane: the byte
is XORed with a lane-and-position-dependent salt (`bytes[i] ^ ((s+1) << ((i&3)*8))`,
`blob-store.ts:62`) before folding through an FNV-prime multiply implemented as shift/add
(`h + (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)`, which is exactly `h * 16_777_619` — the FNV-1a
32-bit prime — done without `imul` for perf, `blob-store.ts:63`). Output: 4× 8-hex-digit lanes
concatenated, 32 lowercase hex chars (`blob-store.ts:67`). This is a genuinely different byte
stream than #1a: it hashes *whatever bytes the caller serialized the blob into* (format
undefined by this file — up to the producer), not a fixed positions/indices/origin schema, and
the salt makes it not literally "4 rounds of vanilla FNV-1a" despite the doc comment
(`blob-store.ts:52-55`) calling it that.

Content-addresses the CRDT geometry blob store (`docs/architecture` spec §11.1, see file header
comment `blob-store.ts:6`): `MemoryBlobStore`, `IndexedDbBlobStore`, `HttpBlobStore`,
`LayeredBlobStore` all key blobs by `fnv128(bytes)`. `packages/collab/src/geometry/parametric.ts`
has a near-twin, `hashMesh` (`parametric.ts:268-296`): same 4-lane shift/add-FNV-1a scheme and
same seed table, but *without* the salt, and hashing a **decimal-string encoding**
(`positions[i].toFixed(8)` joined with commas, then indices as plain `String(v)`,
`parametric.ts:271-278`) rather than raw bytes — used by the parametric-source determinism
harness (`determinism.ts` in the same directory), not by the blob store itself.

### 1c. Diff engine geometry fingerprint — `rust/geometry/src/geom_hash.rs` + `packages/diff`

This is the one the B0.1 brief calls "`packages/diff/src/fingerprint.ts` +
`component-fingerprint.ts`" — that description undersells it. `packages/diff/src/fingerprint.ts`
(`fingerprint.ts:1-202`) is actually the **data** fingerprint: `buildDataFingerprint` (line 105)
FNV-1a32-hashes (`stableHash`, `fingerprint.ts:49-56`, a textbook 32-bit FNV-1a over UTF-16 code
units) a `JSON.stringify` of the entity's attrs/psets/qsets/type-assignments, each level
recursively key-sorted (`stableSerialize`, `fingerprint.ts:63-73`) so key-insertion order can't
produce a spurious diff. `buildComponentFingerprints` (`fingerprint.ts:174-202`) is the same
scheme, split into one sub-hash per `attr:core` / `pset:<Name>` / `qset:<Name>` /
`type-assignment` key — there is no separate `component-fingerprint.ts` file; that logic lives in
`fingerprint.ts` itself (confirmed: only `component-fingerprint.test.ts` exists, importing from
`./fingerprint.js`).

The **geometry** half — the actual "RTC-invariant hash" the brief means — is computed in Rust,
not TypeScript: `rust/geometry/src/geom_hash.rs`. `GeometryHasher` (lines 74-204) is built per
entity from `(tolerance: f64, rtc_offset: [f64;3])` and fed one or more mesh segments via
`add_mesh_with_origin` (lines 125-183):

1. Each triangle corner is reconstructed to **world** coordinates
   (`position as f64 + origin[axis] + rtc[axis]`, `geom_hash.rs:104-111`) — this is what makes it
   RTC-invariant: the file's own RTC/local-frame choice is added back out before hashing, so the
   same wall at the same world location hashes identically regardless of which offset either
   file picked (proven by the `rtc_invariance_same_world_geometry` test, `geom_hash.rs:246-271`).
2. Each world corner is **quantized** to a grid (`round(world / tolerance)`, default tolerance
   1 mm — `DEFAULT_GEOM_HASH_TOLERANCE`, `geom_hash.rs:43,65-69`) so float re-triangulation noise
   below the grid is absorbed (`sub_tolerance_jitter_is_ignored` test, lines 300-319).
3. A triangle's three quantized corners are **sorted** (`geom_hash.rs:146`) before hashing, and
   degenerate (post-quantization zero-area) triangles are skipped (lines 148-171) — this makes
   the hash winding- and vertex-start-invariant (`winding_invariant` test, lines 339-349) and
   immune to triangulation noise.
4. Per-triangle hash uses `mix64`/`fold_i64` (splitmix64 finalizer, lines 49-59) seeded
   `0x5bd1_e995`, folding the 9 quantized `i64` coordinates (line 173-178).
5. Triangles combine via a **commutative running sum** (`wrapping_add`, not a rolling hash) across
   segments (line 180) — so triangle emission order and mesh-segment splitting don't affect the
   result (`triangle_and_vertex_order_invariant`, `segment_split_matches_single_segment` tests).
6. `finish()` (lines 199-203) folds in the triangle count (guards against a collision on the
   commutative sum alone) and re-mixes.

Exposed to JS as a `u64` per element via wasm: `rust/wasm-bindings/src/zero_copy/mesh.rs:445-446`
(`geometry_hash_ids: Vec<u32>`, `geometry_hash_values: Vec<u64>`, parallel arrays), getters at
lines 571-588 (`geometryHashIds` / `geometryHashValues` — a `BigUint64Array`, `js_sys` conversion
line 581). `packages/diff/src/types.ts:30-35` documents `GeometryHash = bigint | string` exactly
for this reason. `apps/viewer/src/lib/compare/buildFingerprints.ts:82-136` is the actual
consumer: it pulls `mesh.geometryHash` per entity (`buildFingerprints.ts:93`, falling back to
`instancedGeometryHashes` for GPU-instanced-only entities that never hit the flat `meshes` array,
lines 98-109) and pairs it with `buildDataFingerprint(...)` into one `EntityFingerprint` per
entity (line 118-124). `packages/diff/src/diff.ts:25-29` (`geometryEqual`) does string-normalized
comparison since a `bigint` and its `string` form must compare equal.

Also worth flagging (not a candidate for unification, but adjacent and easy to confuse with 1c):
`rust/geometry/src/router/caching.rs` has its own **FxHasher**-based `compute_mesh_hash` (64-bit,
sampled for large meshes) and `compute_mesh_hash_full` (128-bit, two independent FxHasher lanes)
— purely an in-process content-addressed **dedup cache** for repeated geometry within one run
(`get_or_cache_by_hash`, lines 130-152) and the GPU-instancing `rep_identity` key. `FxHasher`'s
output is not guaranteed stable across Rust/rustc versions and is never persisted or compared
cross-process, so it is explicitly **out of scope** for node-hash-v0 (see §6 Q4).

### 1d. Bonus: IFCX layer content-addressing — `packages/ifcx/src/canonical.ts`

Found while tracing where a "layer" hash already exists in this repo (the B0.1 brief's v0 node
kind list includes "layer", and `docs/architecture/layer-prs/02-layer-format.md` §2.4 already
specs `layerId = blake3(canonical_bytes)`). This is **implemented**, not just spec'd:
`computeLayerId` (`canonical.ts:135-137`) hashes `canonicalizeLayer(file)` with blake3
(`@noble/hashes/blake3`, an existing dependency of `@ifc-lite/ifcx`, `packages/ifcx/package.json`)
and prefixes the result `blake3:<hex>`. `canonicalizeLayer` (`canonical.ts:82-114`): strips
`ifclite::derived` cache nodes and attributes, canonicalizes every node with `canonicalStringify`
(sorted object keys, NFC-normalized strings, negative-zero folded to zero, no whitespace — lines
40-72), stable-sorts nodes by path (same-path opinion order is semantic and preserved, line 93),
excludes the manifest's own `signatures` field (self-referential — signatures sign the id,
`canonical.ts:100-105`), and joins `data`/`header`/`imports`/`schemas` into one canonical JSON
string. `computeStackHash` (lines 144-147) is blake3 over newline-joined layer ids — a stack's
identity. Used live by `packages/merge/src/merge-layer.ts:262-265`, `inverse.ts:116`, and
`ref-flow-resolutions.test.ts`.

This is a real fourth production system, already blake3, already canonical-JSON-based, already
literally called a "layer" hash. §3.4 and §6 Q1 address how v0's "layer" node kind relates to it.

## 2. Node kinds (v0)

- **`geometry-mesh`** — a leaf. One element's tessellated output (positions, normals, indices,
  origin, express id, geometry class). No children.
- **`property-set`** — a leaf w.r.t. geometry, composite w.r.t. its own properties: a named set
  of `(name, value)` pairs (a Pset or Qset).
- **`relationship`** — a named IFC relationship (`IfcRelVoidsElement`, `IfcRelAggregates`, ...)
  between a fixed set of named roles, each role holding one or more node references.
- **`layer`** — a set of ops (per `docs/architecture/layer-prs/02-layer-format.md` §2.2) applied
  on top of a base state; a Merkle node over the entity/element hashes it touches.
- **`element`** — composite: one element's per-component-key hashes folded together (its
  `geometry-mesh` hash if any, its `property-set`/`qset` hashes, its `relationship`
  memberships, its type-assignment) — the per-entity unit a certificate's `reads`/`writes` most
  naturally reference.

## 3. Canonical hash algorithm and byte encoding, per kind

Every node hash is a **tagged string**: `"<algorithm>:<hex-or-0x-form>"`. The tag travels with the
hash everywhere (reads, writes, claims) so a verifier never has to guess which algorithm produced
a given value, and so §4's "same kernel version, same trust root" rule has something concrete to
check against. Two algorithms are used in v0, deliberately not one:

### 3.1 Leaf kind `geometry-mesh` → FNV-1a64, reusing `determinism.rs`'s exact encoding

**Decision: do not re-serialize mesh data.** The `rust/processing/tests/manifests/mesh_determinism.json`
manifest is already a CI-pinned, cross-target (x86_64/aarch64/wasm32) proof that this exact byte
encoding is deterministic. Inventing a new mesh serialization for node-hash-v0 would (a) duplicate
that proof for no reason and (b) risk drifting from it, defeating the whole "reuse the kernel's
own determinism" premise of M1. So `computeNodeHash('geometry-mesh', payload)` ports
`determinism.rs`'s per-mesh fold **verbatim**:

```
hp  = fnv1a64(positions[i].bits_le for i in 0..len)      // f32 bit pattern, little-endian
hn  = fnv1a64(normals[i].bits_le for i in 0..len)         // f32 bit pattern, little-endian
hio = fnv1a64( express_id.to_le_bytes()                   // u32 LE
             ++ [geometry_class]                          // single u8
             ++ (indices[i].to_le_bytes() for i in indices) // u32 LE each
             ++ (origin[0].bits_le ++ origin[1].bits_le ++ origin[2].bits_le) ) // f64 LE each
node_hash = fnv1a64( hp.to_le_bytes() ++ hn.to_le_bytes() ++ hio.to_le_bytes() )
          = "fnv1a64:0x" + hex(node_hash)
```

This is exactly the per-mesh contribution folded into `determinism.rs`'s whole-fixture `top`
(`determinism.rs:329-331`) — a `geometry-mesh` node hash is directly comparable, mesh-by-mesh, to
the pinned entries in `mesh_determinism.json`'s `meshes[]` array (same `positions_hash` /
`normals_hash` construction, plus the same 3-hash fold as the per-mesh slice of `top`). Offset
basis and prime are the pinned constants (`0xcbf2_9ce4_8422_2325`, `0x0000_0100_0000_01b3`).

**Field domains are normative, and out-of-domain payloads are rejected, not coerced.** The
encoding above is a verbatim port of a Rust wire format, so the fields carry Rust's types:
`express_id` and every index are `u32` (integers in `[0, 4294967295]`), `geometry_class` is a `u8`
(integer in `[0, 255]`), positions and normals are `f32` (finite, and finite once narrowed to
`f32`), and `origin` is exactly three finite `f64`. A host language with one numeric type (a
TypeScript port hashing `number`) must **reject** anything outside those domains rather than
truncate it: masking `geometry_class` with `& 0xff` or forcing an index through `v >>> 0` maps
distinct payloads onto one hash (`1`/`257`/`-255`; `100`/`100.9`/`100 + 2**32`; `[-1]`/
`[4294967295]`), which is a second preimage a certificate would verify. Rejection is a
**conformance rule, not part of the wire format** — it changes no accepted payload's bytes, and no
golden vector can pin it, because a vector fixes how an accepted payload encodes while this fixes
which payloads are accepted at all. In-range `f64 → f32` narrowing is inherent to the frozen format
and stays as-is; only values with no `f32` at all (NaN, ±Infinity, and finite doubles like `1e39`
that narrow to Infinity) are out of domain.

This hash is **byte-exact, not RTC-invariant** — it is a proof of "the kernel reproduced this
exact geometry," not "this geometry is semantically the same shape." That is the correct choice
for a certificate whose whole point is proving deterministic replay (§4), and it is deliberately
a *different* invariant than system 1c's RTC-invariant diff hash — see §6 Q2 for whether v0
should also carry a secondary semantic-equivalence hash per mesh node.

### 3.2 Composite/DAG kinds → SHA-256 over a canonical binary encoding, Merkle-linked

`property-set`, `relationship`, `layer`, `element` are all instances of "hash my own fields plus
my children's hashes." v0 uses **SHA-256 via WebCrypto** (`crypto.subtle.digest('SHA-256', ...)`)
— zero new dependencies (available in every evergreen browser and Node 22, this repo's pinned
engine), which is the constraint the B0.1 prototype must satisfy. A **common binary framing** is
shared across all four composite kinds so the encoding rules are stated once:

- All multi-byte integers are **little-endian**.
- Every **string** field is **NFC-normalized by the hasher** (Unicode Normalization Form C) and
  then encoded as `u32` LE byte-length prefix, followed by its UTF-8 bytes.
- Every **f64** field is its raw IEEE-754 bit pattern, 8 bytes, little-endian
  (`DataView.setFloat64(offset, v, /* littleEndian */ true)`).
- Every **count** (array/map length) is a `u32` LE prefix before the elements it introduces.
- A **child-hash reference** is encoded as a string field (see above) holding the *tagged* hash
  string of the child (`"fnv1a64:0x..."` or `"sha256:..."`) — the parent never needs to know or
  care which algorithm produced a child's hash, only its canonical string form. This is what
  makes the scheme Merkle: change any byte of a child's payload → child's hash string changes →
  every ancestor's canonical bytes (which embed that string) change → every ancestor's hash
  changes, and *only* ancestors on that path (§3.5, verified by the DAG test in the prototype).
- Every node's encoding starts with a fixed 6-byte header: 4-byte ASCII magic `"NHV0"`, 1-byte
  kind tag (`1=property-set, 2=relationship, 3=layer, 4=element`), 1-byte format version (`0`).
- Wherever a field is semantically a **set** (property-set members, a relationship role's related
  objects, a layer's child ops) rather than a **sequence**, entries are sorted before encoding —
  by property/role name for named entries, by the child's own tagged hash string (plain byte
  compare, not locale-aware) when entries are themselves unordered hash references. This keeps
  the hash order-independent exactly where IFC's own semantics are order-independent (e.g.
  `IfcRelAggregates.RelatedObjects` is a set) and preserves order exactly where it's semantic
  (e.g. a layer's op sequence, per `02-layer-format.md` §2.4's own "same-path opinion order is
  preserved" rule for the pre-existing `computeLayerId`).
- **Normalization applies to sorting as well as to encoding.** Set ordering compares the
  **NFC-normalized UTF-8 bytes** — byte-for-byte the same bytes the string encoding above will
  write — never the producer's raw pre-normalization spelling. Sorting raw and encoding normalized
  would let the *spelling* pick the order: `{"é"(NFD), "z"}` and `{"é"(NFC), "z"}` are one and the
  same set after NFC, but raw-byte order puts NFD `é` (`0x65 0xcc 0x81`) before `z` and NFC `é`
  (`0xc3 0xa9`) after it, so one canonical input would produce two different hashes. That dual is
  worse than a collision for a verifier: "recompute and compare" would fail on honest data. Two
  entries whose spellings differ but whose NFC forms are equal compare equal; the sort is **stable**
  (producer order is kept), and since their encoded key bytes are identical by construction the
  byte stream does not depend on which of the two the sort places first.

Per kind:

**`property-set`**: header, `name` (string), `propertyCount` (u32), then properties **sorted by
name** (ordinal UTF-8 byte compare), each: `name` (string), `valueKind` tag byte
(`0=null,1=string,2=number,3=boolean`), value bytes per kind (string: as above; number: f64 LE;
boolean: 1 byte; null: no payload). Mirrors `buildComponentFingerprints`'s per-pset sub-hash
(`fingerprint.ts:189-191`) but byte-precise instead of `JSON.stringify`-precise.

**`relationship`**: header, `relType` (string, e.g. `"IfcRelVoidsElement"`), `roleCount` (u32),
then roles **sorted by role name**, each: `roleName` (string), `refCount` (u32), then child-hash
references **sorted by tagged hash string** (a role's members are encoded as a set; a role whose
IFC attribute is singular simply carries one reference). A payload commits only the roles its
producer includes — omitting a role and carrying it with zero refs are different byte streams and
therefore different hashes.

**`layer`**: header, `layerId` (string — the ifcx layer identity, see §6 Q1), `opCount` (u32),
then child-hash references (the element/entity hashes this
layer's ops touch) **sorted by tagged hash string**. v0 deliberately keeps this minimal (no op
metadata, no author) — see §6 Q1 on reconciling with `computeLayerId`'s much richer canonical-JSON
scheme, which is a different (and already shipping) answer to a similar question.

**`element`**: header, `key` (string — the entity's stable identity, typically `GlobalId`),
`ifcType` (string), `componentCount` (u32), then components **sorted by componentKey** (using the
existing `ComponentKey` vocabulary from `packages/diff/src/fingerprint.ts:162` /
`02-layer-format.md` §2.2: `attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`,
`geometry-mesh`, `relationship:<RelType>`), each: `componentKey` (string), child-hash reference
(string).

### 3.2.1 Identifier conventions (normative, frozen)

Every IFC identifier that reaches a hash — `relationship.relType`, `relationship.roleName`,
`element.ifcType`, and the `<RelType>` / `<Name>` parts of a `componentKey` — is encoded
**verbatim** as an ordinary NFC UTF-8 string field. The hasher applies **no case folding, no
aliasing, and no schema lookup**: it commits to exactly the string the producer supplied, so two
producers only agree if they spell identifiers the same way. The freeze therefore pins the
spelling, not just the bytes:

- **Relationship type and role names are the exact IFC EXPRESS names** of the relationship
  (AGENTS.md "IFC schema fidelity": full names, never invented aliases). `IfcRelVoidsElement`
  carries `RelatingBuildingElement` and the **singular** `RelatedOpeningElement`;
  `IfcRelAggregates` carries `RelatingObject` and `RelatedObjects`;
  `IfcRelContainedInSpatialStructure` carries `RelatingStructure` and `RelatedElements`. A
  pluralized or otherwise invented role name is a non-conforming payload: its hash is
  well-defined but no schema-faithful implementation can reproduce it.
- **`element.ifcType` is the exact IFC EXPRESS PascalCase type name** (`IfcWallStandardCase`) —
  what the canonical load path yields via `store.entities.getTypeName(id)` — **not** the
  uppercase STEP storage spelling (`IFCWALLSTANDARDCASE`). Both are technically hashable strings,
  and the uppercase form deliberately hashes differently; the golden vectors pin that difference
  (`el-basic` vs `el-step-uppercase-name`) so the mismatch surfaces as a distinct hash rather
  than as a silent interoperability failure.

### 3.3 Why two algorithms, not one

A single algorithm end-to-end would be simpler to explain, but:

- Re-deriving the mesh leaf hash with SHA-256 would require re-serializing mesh bytes in a new
  format, duplicating and risking drift from the CI-pinned `determinism.rs` encoding — exactly
  what the B0.1 brief says not to do.
- Re-deriving the composite hash with FNV-1a64 would give up SHA-256's much stronger collision
  resistance where it matters most: certificates are a *trust* mechanism (§0's "governance layer
  for agent autonomy"), and the composite layer is where an adversarial actor (a compromised
  agent, a malicious proxy) would try to forge a claim. FNV-1a64 is fine for CI drift-catching
  (nobody is adversarially engineering an FNV-1a64 collision against your own CI) but is not the
  hash you want backing a cryptographic non-repudiation claim.

The tagged-string scheme (`"fnv1a64:..."` vs `"sha256:..."`) means this is not a leaky
abstraction: any node's hash self-describes its algorithm, and a verifier or a future v1 can
introduce a third algorithm for a new node kind without touching the others.

### 3.4 Relation to the pre-existing blake3 layer hash

`computeLayerId` (§1d) is a real, already-shipping, already-called-"layer" content hash — and it
disagrees with §3.2's `layer` node kind on both algorithm (blake3 vs SHA-256) and encoding
(canonical JSON text vs the binary framing above). v0 does **not** attempt to silently reconcile
this; see §6 Q1. The honest state today: `computeLayerId` hashes *whole layer documents* for
IFCX content-addressing / registry refs (`packages/merge`), while node-hash-v0's `layer` kind is
scoped to *this DAG's* Merkle linkage (one node among many, referenced by parents). Resolved by
§6 Q1 (2026-07-24, part of the frozen format): the DAG `layer` node EMBEDS the ifcx blake3
`layerId` as its first payload field and keeps SHA-256 for its own hash — embed, don't compete.

### 3.5 Merkle rule

A parent node's canonical bytes **embed its children's tagged hash strings** (never the
children's raw payload) as ordinary string fields, per the framing in §3.2. Hashing those bytes
therefore transitively commits to every descendant: if any leaf's payload changes, its own hash
changes (a different byte stream to `computeNodeHash`), which changes the string embedded in its
parent's canonical bytes, which changes the parent's hash, and so on up to the root. Nodes *not*
on the path from the changed leaf to the root reference the same unchanged child hash strings and
therefore recompute to byte-identical canonical bytes and byte-identical hashes. This is the
property the prototype's DAG test asserts directly (§Step 3, "single-leaf change flips exactly
the ancestor-path hashes").

## 4. Versioning and trust root

Hashes are **not** universally comparable — they are comparable only under an identical
`(kernelVersion, trustRoot)` pair, and a certificate must pin both:

- **`kernelVersion`** — identifies the geometry-kernel build that produced any `geometry-mesh`
  hashes referenced by the certificate (e.g. the `ifc-lite-geometry` crate version, or a build
  id/git sha for finer granularity than semver bumps allow). Two builds at the same semver can
  still diverge in float rounding under different `rustc`/LTO/target settings — semver alone is
  not a strong enough anchor.
- **`trustRoot`** — the kernel's own determinism proof at the time of hashing: the predicate-sign
  manifest hash from `rust/geometry/src/kernel/manifest.rs::indirect_sign_manifest()` (FNV-1a64
  over 1000 fixed-seed predicate-sign batteries, `manifest.rs:50-52` — "the determinism-bar proof
  for the predicate layer," per that file's own doc comment). This is the right anchor because
  it's *already* the thing the kernel team maintains as the source of truth for "did predicate
  logic change in a way that could move a sign, and therefore a triangulation, and therefore a
  mesh hash" — reusing it instead of minting a new "geometry semantics version" avoids a second,
  competing versioning scheme.

A certificate's claims are only meaningful if `verifyCertificate` is called with a resolver whose
`(kernelVersion, trustRoot)` matches the certificate's declared values; a mismatch must fail
verification outright (§Step 3), independent of whether any individual hash recomputes correctly
— a byte-identical mesh hash produced by a *different* kernel build under a *different* trust
root is not evidence of anything, even if it happens to match.

## 5. DAG linkage

See §3.5 (Merkle rule) for the mechanics. At the certificate level (§Step 3): `reads` and `writes`
are `{ nodeId, hash }` pairs — the set of DAG nodes a change touched as inputs and outputs. A
`subtree-untouched` claim names a set of node hashes that must recompute unchanged; verification
walks from any claimed-unchanged ancestor down through the resolver only far enough to confirm
its hash matches — it does not need to re-walk the whole DAG, which is the whole point (cheap
subtree replay, per the Gate G0 framing in `moonshots-execution-plan.md` line 241-243).

## 6. Appendix: design decisions (ALL RESOLVED by Louis, 2026-07-24)

Historical record. All five questions below were decided on 2026-07-24 and the decisions are
part of the frozen format (see the FROZEN header block); the original question text is preserved
for the record, each followed by the decision. Summary:

- **Q1 — Embed, don't compete.** The DAG `layer` node EMBEDS the ifcx blake3 `layerId`
  (`computeLayerId` output, tagged string) as its first payload field; the node's own hash
  stays SHA-256 like every composite. One node carries both the document identity and the
  effect commitment. Implemented: `LayerPayload.layerId`, encoded immediately after the header.
- **Q2 — Both hashes in v0.** `geometry-mesh` nodes carry the byte-exact `fnv1a64:` node hash
  (the only hash certificates may claim over) plus an optional `semanticHash` annotation (the
  RTC-invariant `geom_hash.rs` u64 already exposed via wasm `geometryHashValues`) for
  dedup/memoization. The annotation is deliberately NOT folded into the node hash; a test pins
  that.
- **Q3 — Assert-style with mandatory binding.** `scalar-delta` claims restrict `metric` to a
  registered vocabulary (`net-volume` → reads `NetVolume`, `element-count` → reads
  `ElementCount`, `property-numeric` → reads the claim's own `property` field) and
  `beforeNodeId`/`afterNodeId` are mandatory: a scalar claim that does not bind to DAG nodes
  is a free-floating assertion. Verifier-derived deltas from geometry diffs remain a
  B1.1/B1.4 concern.
- **Q4 — Confirmed out of scope.** The FxHasher dedup caches stay excluded (toolchain-unstable,
  never persisted).
- **Q5 — Reserve now, sign in M4.** `Certificate.signatures?` mirrors the ifcx
  provenance-manifest signature shape (`{alg: 'ed25519', key, sig}`) and is ignored by v0
  verification; actual signing lands with M4 (Phase 2); key custody is a human-calendar item.
  See the FROZEN header block's reserved-fields entry for the two constraints on that landing:
  v0 defines no canonical certificate byte encoding (so there is nothing well-defined to sign
  over yet), and M4 must mint a new version string rather than sign under `node-hash-v0`.

### Original questions (for the record)

1. **Blake3 layer collision (§3.4).** `packages/ifcx`'s `computeLayerId` already exists, is
   already in production use (`packages/merge`), and is already called a "layer" hash. Should
   node-hash-v0's `layer` node kind (a) become a thin wrapper that just re-tags `computeLayerId`'s
   output (`blake3:...`) as a node hash, making blake3 the third algorithm in this spec; (b) stay
   as designed here (SHA-256, binary framing, DAG-local scope) and rename to avoid the collision
   (e.g. `dag-layer` vs `ifcx-layer`); or (c) something else? This needs a decision before v0
   freezes — right now the spec has two different things with the same name.
2. **Should `geometry-mesh` carry a second, RTC-invariant hash?** §3.1's node hash is byte-exact
   (proves "the kernel reproduced this"). System 1c's RTC-invariant hash proves a different,
   arguably more useful thing for memoization/caching (M1's "the hash of a standard door's
   geometry is the same hash in Tokyo and Zurich" — byte-exact hashing defeats that if the two
   copies sit at different RTC offsets or came from slightly different kernel float rounding).
   Should v0 mesh nodes carry both (`fnv1a64:...` for certificate replay-proof, plus a
   `geomhash64:...` secondary field for semantic dedup), or is that a v1 concern?
3. **`scalar-delta` claim scope.** The prototype's `scalar-delta` claim (§Step 3) verifies
   `after - before === delta` and, when `beforeNodeId`/`afterNodeId` are supplied, that those
   resolve to payloads exposing the claimed `metric` value. Is that the right verification
   contract, or should scalar deltas (net volume change, clearance minimums) be derived
   automatically from geometry-mesh diffs rather than asserted against arbitrary property
   payloads? The latter is more rigorous but needs a defined `metric` vocabulary and a
   computation, not just a check — likely a B1.1/B1.4 concern (Merkle DAG + region footprints),
   not B0.1.
4. **`FxHasher`-based dedup caches confirmed out of scope.** `rust/geometry/src/router/caching.rs`
   (`compute_mesh_hash`, `compute_mesh_hash_full`) are excluded from unification because they are
   not stable across Rust toolchains/versions and are never persisted — confirming this reading
   is correct, not proposing to change it.
5. **Certificate transport/signing.** v0's `Certificate` type (§Step 3) has no signature field —
   `createCertificate`/`verifyCertificate` prove internal consistency (claims match resolvable
   data) but not *who* made the claim. M4's "encrypted multiplayer, verify each other's merges via
   hashes" and the provenance-manifest `signatures` field already excluded from `computeLayerId`
   (§1d) suggest signing belongs here eventually — is that in scope for a later B0.x, or does it
   ride on `packages/ifcx`'s existing provenance-manifest signature plumbing instead of a new one?
