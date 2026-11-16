---
"@ifc-lite/mutations": minor
"@ifc-lite/create": patch
"@ifc-lite/export": patch
---

Reduce per-record attribute observer allocations and remove replaced authored geometry from the mutation journal without scanning unrelated session history. Bound the frozen entity snapshot memo while preserving held snapshots, exported mutations, detached drafts and compound undo order.

Enumerate created IDs without materializing attribute snapshots during export index and collision checks.

Add a constant-time relative creation-order query so bounded relationship lookups preserve canonical order after retargeting and inside nested drafts.

Index requested positional reference slots with an unresolved bucket, and narrow opening host/fill reads while preserving conservative malformed-host refusals.

Maintain ID-only storey planning inventories across geometry edits and unchanged atomic drafts. Plan exceptional placements and unequal-delta attachment groups in detail while retaining the complete moved product list, refusal and undo contracts. Expose a bounded, disposable entity-change cursor for derived inventories.

Keep read-only derived inventories request-scoped so hierarchy dependency tracking stays correct without retaining mutation subscriptions for temporary views.

Read attachment metadata GUIDs through borrowed snapshots during export so a save does not make later transactions copy every authored product as a mutable alias.

Invalidate planning classifications when product GUIDs or placement classes change, preserving unresolved attachment notices and unreadable-placement refusals.

Avoid cold reference-projection allocations for small relationship classes while bounding direct lookup work.

Release completed transaction indexes and collect evicted read snapshots during synchronous sessions, while preserving retained draft views and already exposed mutable aliases.

Keep borrow and exposure state in the shared attribute barrier to avoid duplicate weak-collection lookups and cache metadata allocations.

Keep attribute barriers on their owning records as non-enumerable metadata, avoiding a session-wide weak-table insertion during a bounded edit. Metadata stays out of cloned and exported records.

Clone appended mutation-journal rows as one detached batch instead of invoking serialization separately for each new mutation.
