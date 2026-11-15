---
"@ifc-lite/mutations": minor
"@ifc-lite/create": patch
"@ifc-lite/export": patch
---

Reduce per-record attribute observer allocations and remove replaced authored geometry from the mutation journal without scanning unrelated session history. Bound the frozen entity snapshot memo while preserving held snapshots, exported mutations, detached drafts and compound undo order.

Enumerate created IDs without materializing attribute snapshots during export index and collision checks.

Add a constant-time relative creation-order query so bounded relationship lookups preserve canonical order after retargeting and inside nested drafts.
