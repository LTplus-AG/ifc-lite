<!-- SPDX-License-Identifier: MPL-2.0 -->
# Source decoder cache resource retention: frozen prerequisite

Status: **design and characterization only; no production retention seam**.
Inspected base: `4251bceb10db6fd4b8291f647917bb7617929f06`.
This change neither enables reached-region production capture nor changes the
selected decoder, source provenance, duplicate policy, or default behavior.
All added Rust tests and compilation/Clippy are **UNRUN**. Both fleet hosts
reported admission refused, guard exit 78; no validation job was submitted.
The previously reported parent7fc foundation results do not qualify this change
or the corrected execution guards in base 4251.

## Required contract

A future implementation must borrow the SAME context-validated selected
`EntityDecoder`, under actual ProductOwner source work. Validate the live
execution instance/generation, cache provenance revision and active ancestor
work epoch before authorizing allocation. A fresh inspection decoder, a waiting
lease, a public resource token, and identical source bytes are insufficient.
Core remains independent of geometry `resource::Reservation`.
`SourceResourceContext` is an opaque account carrier, not source authority.

Admission must precede allocation, including growth and transient overlap.
Opaque permits must accompany the actual owning allocation through every move
and sharing operation. Expiring execution ends permission to allocate; it must
not release permits for still-live backing. Refusal must leave established
backing and provenance intact, release provisional permits, and reach the
existing terminal stop path without becoming a successful default value.

Live backing includes retained capacity, nested attribute storage and shared
owners, not merely populated entries. A cache hit does not charge shared
attribute backing again, while a new destination map still requires its own
bucket allocation. Existing original bytes are not recharged or used as an
identity test. Any admission estimate needs a checked conservative bound for
actual capacities and allocator metadata, with a documented accounting domain;
raw record length alone does not bound decoded allocation overhead.

## Source-backed ownership inventory

- `src/schema_gen.rs`: `DecodedEntity::attributes` is public
  `Arc<Vec<AttributeValue>>`. Callers may clone it separately, replace it, use
  `Arc::make_mut`, or unwrap the Vec. Nested `AttributeValue` strings/lists are
  owned allocations. Putting a permit beside an entity or inside its outer
  `Arc<DecodedEntity>` cannot retain it with a separately surviving attribute
  Arc. A weak-pointer registry cannot release precisely at backing destruction.
- `src/decoder.rs`: `admit` materializes attribute trees and `DecodedEntity::new`
  allocates the attribute Arc. `parse_at` allocates token lists first via
  `parser/tokenizer.rs`. `decode_at` shares the attribute Arc with a cached
  entity. `decode_at_uncached` returns owned backing without a cache owner.
  `decode_and_cache` also returns an externally retainable `Arc<DecodedEntity>`.
  `reserve_cache` and decoded-cache insertion allocate buckets separately.
- `src/decoder/caches.rs`: `clear_cache`, `clear_entity_cache`, and
  `clear_point_cache` retain hash-map capacity. `drain_cache`, `take_point_cache`
  and `take_placement_transform_cache` return bare maps whose allocations outlive
  the decoder. A decoder-local permit vector cannot follow these maps.
- `src/decoder/source_caches.rs`: `SourceCache<T>` owns its map, source Arc and
  revision. Checked point/placement installation moves only `entries` into the
  decoder. Checked decoded injection clones entity Arcs into a different map.
  A permit added only to `SourceCache` would be dropped too early after either
  operation, and would not cover raw transfer APIs. Empty maps may own capacity.
  A rejected decoded injection borrows and leaves the donor intact; rejected
  point/placement installation consumes its donor. These lifetimes differ.
- `src/decoder/fast_buffers.rs`: polyloop reads insert point-cache entries while
  filling caller-owned Vec scratch. Failure may leave successfully resolved
  points cached; clearing scratch does not release its capacity. `Option` failure
  currently represents malformed/missing data, not resource admission.
- `src/decoder.rs` plus `src/units.rs`, `src/units_length.rs` and
  `src/project_units/`: lazy project/unit resolution can populate decoded entity
  caches. Scalar unit results are inline, but their computation is not allocation
  free. `length_unit_scale` and `plane_angle_to_radians` preserve existing
  fallback behavior; resource failure must not be swallowed into those defaults.
- `src/decoder/precision.rs`: cached precision success is inline; cached failure
  owns a String. Each returned error clones that String. The scan materializes
  uncached context entities. Ordinary cache clears do not reset this memo.
- `src/decoder/schema_layout.rs`: `Arc<GridAxisIndex>` owns a lazy OnceLock map;
  callers and source/index owners can retain it beyond a decoder. Building it
  also decodes temporary grid attributes. `set_grid_axis_index` is a compatibility
  input and revokes cache authority, even with an empty index.
- `src/decoder/styled_items.rs`: inverse maps and nested id Vecs (or a cached
  error String) live in the decoder, SourceBundle for coherent columnar decoders,
  or a supplied columnar index for compatibility decoders. Preserve these cache
  domains; moving all of them into SourceBundle would change default behavior.
- `src/source_bundle.rs`, `src/source_index.rs`, `src/columnar_index.rs` and
  `src/dense_index.rs`: source/index storage and lazy auxiliary owners are
  distinct from a decoder lifetime. Source construction already allocates before
  a later capture transaction exists. Existing storage needs an explicit
  precharged adoption policy or fail-closed unsupported coverage, never a claim
  of pre-admission made retroactively. Columnar/dense indexes also share grid
  owners; columnar index owns the compatibility styled-item memo.
- `src/execution_owner.rs` and `src/execution_owner/resource_context.rs`:
  execution identity, work epoch and stop propagation govern active work. An
  expired child can retain resource context storage until dropped. That context
  is not coupled to cache backing; after it drops, escaped attributes can remain.

## Why a bounded opt-in addition is not implemented

There is no destructor hook in `Arc<Vec<AttributeValue>>` or a bare `FxHashMap`
for an independently attached permit. No safe sidecar can observe their final
backing destruction synchronously. A global allocator hook, leaking permits,
charging the raw snapshot, or trusting user-supplied tokens would not establish
the required ownership contract. Charges on the decoder fail after drain and
external Arc escape; charges on SourceCache fail after entry installation and
shared injection. Rejecting all allocations is not a successful retention seam.

An owner-carrying attribute type must prevent extraction of unaccompanied shared
backing and handle copy-on-write/deep-copy admission. Existing consumers call
`Arc::make_mut`, including geometry program tests and production processing
appearance code (`evaluated.rs`, `evaluated_replacement.rs`); changing that field
requires coordinated API migration and validation beyond this core-only task.
Raw map export signatures likewise cannot carry ownership without changing their
contract or forbidding those operations under a resource mode. Their infallible
signatures do not currently express a structured resource refusal.

## Smallest coherent follow-up, before production binding

1. Approve an allocation-owning attribute abstraction and cache-table abstraction.
   Each owns backing followed by opaque permits, so backing destruction precedes
   permit release. Expose borrowed reads and permit-preserving moves/shares only.
   Admit copy-on-write and nested tree copies before allocating. Preserve the
   default decoder's outputs, parser, duplicate policy and cache domains.
2. Migrate all actual ownership routes together. Owned cache export/import must
   move permits with map backing; checked decoded injection shares entity backing
   but admits its new destination buckets. Define compatibility raw APIs under
   opt-in mode explicitly, with fallible counterparts or a checked restricted
   decoder interface. Do not silently release permits on raw export, promote raw
   imports, or bypass the existing source revision rules.
3. Add a core-owned resource adapter interface accepting allocation requests and
   returning opaque owned permits or the existing fixed-size ProgramStop. The
   adapter transports accounting only. Install it only through a checked borrow
   of the selected decoder's existing source work, never a token-based source
   constructor. Geometry implements the adapter later; this task adds none.
4. Cover parser staging, string decoding, nested attributes, bucket growth,
   unit/precision work, refusal bookkeeping, and lazy shared-index construction.
   Use checked arithmetic, fallible reserve where available, and bound Arc
   allocation strategy explicitly. Keep old backing charged during replacement.
   Define allocation rollback, shared OnceLock first-writer charging, and cached
   failure-string ownership before claiming coverage.
5. Deal explicitly with warm caches and supplied shared indexes. Backing without
   retained admission cannot become authenticated/charged by retrospective size
   measurement. Fail closed or arrange an earlier trusted owner transaction;
   retain the same selected decoder and its identity. This decision belongs with
   the parent's private original-source transaction, not an inspection snapshot.
6. Only after lifetime/refusal tests execute under admission may the parent bind
   high-level reached-region capture to this adapter. No geometry/common/runtime/
   native code or exact-capture harness is modified here.

## Characterization and future qualification

`src/decoder/resource_retention_tests.rs` contains seven behavioral tests. They
use real parsed inline STEP, weak allocation references, actual map capacities,
checked source-cache operations and active source-work scopes. They characterize
attribute/outer-Arc escape, typed sharing, clear/drain capacity lifetime, rejected
foreign injection, unwind expiry, and resource context not authenticating raw
imports. They are not tests of a new resource-retention implementation.

After admission is available, parent may run the root-workspace test command
through `ifc-fleet run --cwd ABSOLUTE_CHECKOUT -- cargo test --workspace`, then
`cargo clippy --workspace --all-targets -- -D warnings` through the same launcher.
No package bypass, target override, or nested reservation is needed. Do not call
this change compiled or passing before receipts exist.

The eventual implementation additionally needs allocation-callback refusal
before any allocation, growth overlap and rollback, map clear without premature
release, each raw/checked transfer and failed consuming import, last external
attribute/entity Arc destruction, copy-on-write/extraction, shared-index teardown,
cached error teardown, epoch expiry/cancellation, unwind, and same-byte foreign
source refusal. Record exact default-output equivalence and end-to-end performance
verdict after admitted base/branch runs; no measurement is asserted here.
