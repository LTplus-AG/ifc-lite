<!-- SPDX-License-Identifier: MPL-2.0 -->
# Live decoder cache revision: bounded unit 1

Source base: `256710a69e`. This is a source handoff for the live-revision
prerequisite in `geometry-platform-owner-migration.md`, not completion of unit
1's broader metadata migration. Compilation, execution, Clippy, performance,
and consumer qualification are **UNRUN** for this patch. Parent-owned source
review must precede qualification. Production allocator enrollment stays off.

## Authority contract

Three independent values retain different meanings:

- `ExecutionIdentity.generation` retains its existing configuration behavior.
- `EntityDecoder.cache_revision` retains its existing canonical/raw provenance
  and checked-cache transfer behavior, including canonical zero.
- `ExecutionOwner` privately owns a monotonic live mutation revision and weak
  canonical source link. Its lazily materialized shared state publishes both
  together under one mutex. No decoder reference or address registry is kept.

Captured authority checks the selected decoder/lease, canonical factory source,
owner liveness and reservation, configuration generation, live mutation
revision, independently published source, actual work epoch and its ancestors,
and the paired resource context. Resource identity alone grants no source
identity. Existing original-stop precedence remains intact.

Mutations revoke captured cache work before changing storage or allocating for
an import. Failed or partially completed imports therefore cannot restore old
work. Rejected foreign checked imports return before mutation and preserve
current authority. Accepted mutations need freshly entered work; historical
refund accounts and retained gates can bind that fresh work on the same source.
Lazy canonical memo filling retains its existing behavior and does not advance
the live revision. The existing placement memo caller precondition is unchanged.

## Writer audit

Audited source assignments and mutation entry points before editing:

| Writer family | Live publication |
| --- | --- |
| Raw point/placement setters and raw shared entity import | `revoke_cache_authority` clears live source and advances revision before replacement/reserve/extend; existing provenance revocation and generation behavior remain |
| Grid-index setter | Existing raw revocation helper now publishes live revocation before grid replacement |
| Hash-index setter | Clears live source and advances revision before source/index replacement; method moved into decoder execution module |
| Columnar/dense setters | Existing grid-index setter path revokes before installed index replacement; source provenance remains cleared |
| Factory decoder and pristine bind | Publish canonical source and new live revision after paired index/grid installation and existing provenance reset |
| Checked point/placement/entity imports | Rejection has no mutation; acceptance advances live revision before replacement/extend, including allocation failure/partial import |
| Entity drain, all/entity/point clear, point/placement take | Advance live revision before mutation; checked wrappers use these same paths |
| Unit-scale seeding | Advances live revision before seed replacement; generation behavior unchanged |
| Strict-real configuration | Generation only, intentionally independent of cache revision |
| New borrowed/indexed decoders | Empty live source; no factory authority |
| Canonical lazy index, parse/decode memo, point memo, placement memo, units/Precision/schema/grid/styled initialization | Existing memo semantics unchanged; no new authority is conferred |

Initial owner, state, epoch and source backing remain declared baseline. The
added weak links do not create a strong source cycle. Displaced weak state is
dropped outside its publication lock. There is no metadata-funding claim here.
Ancestry uses the existing iterative epoch validator without an inherited
16-ancestor limit. The binding fixture limit remains unit-test-only; normal
explicit test-support builds use checked depth arithmetic without that quota.

## Review and execution boundary

New `source_resources/revision_tests.rs` covers independent live publication
with unchanged generation and provenance, raw revocation before installation,
generation-only change, live foreign-source mismatch with current revision,
source/index replacement, lazy fill and warm fresh work, checked warm transfer,
rejected foreign import, and mutation discovered at callback return without a
subsequent allocation. The first test exercises the actual private publication
seam directly to isolate revision from every other rejection dimension.
Existing authority tests retain wrong selected owner, same-account foreign
source, joined worker/ancestor expiry, expired scope, resource shadowing,
reentry and original-stop witnesses. All these tests remain UNRUN on this source.

No native/runtime/JS/numerical implementation, allocator-account backend,
normal-library witness/test-support API, parser, cache wire format or public API
was changed. No archival overlays were imported. Units 2+ remain outside this
patch. Parent qualification must use the exact assembled source and fleet
admission; historical results cannot qualify it.
