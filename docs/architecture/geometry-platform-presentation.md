<!-- SPDX-License-Identifier: MPL-2.0 -->
# Late presentation admission and assembly

The canonical per-element producer now separates effective presentation lookup
from final numerical assembly. `element/presentation_source.rs` performs reached
style ancestry, type-map colour and indexed-palette selection after geometry and
extension callbacks. `ReadyPresentation` moves the mesh/instance, resolved
appearance, identity, metadata, frame and hash policy into the same mesh funnel
used by native and browser consumers.

Submesh orientation and normal repair still precede style lookup. Instance-only
and materialized parts share one material-alternation cursor in collection order.
Type-map colour ancestry is resolved once before part filtering; fallback
orientation precedes its indexed-colour representation walk. Texture guards,
palette rejection, source/material identifiers, hashing, welding and metadata
publication retain their existing order. Validated outer work acceptance remains
the once-only authority; ready packets do not introduce public tickets.

Owned packets retain the existing derived palette and rotation Arcs, plus shared
metadata. They do not retain the entire model context or its source authority.
Borrowed assembly views retain caller references without copying model maps.
The lifetime invariant assembles actual textured geometry after the decoder,
router, source, job and model context are gone, with a nonidentity rotation still
retained until assembly finishes. The added tests remain unexecuted pending
machine admission; their existence is not a passing result.

The [delivery and integration record](evidence/geometry-platform-presentation/)
preserves original source hashes, review corrections and validation refusals.
Rust compilation, complete runtime contracts, current-source scene comparisons
and worker-pool performance remain unqualified. Metadata Arc ownership adds an
allocation mechanism that must be included in that measurement. Opening control,
complete effect/resource ownership and explicit retained execution are separate
remaining parts of the full platform migration.
