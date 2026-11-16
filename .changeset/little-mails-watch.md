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
