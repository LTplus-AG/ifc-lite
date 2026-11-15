---
"@ifc-lite/mutations": patch
"@ifc-lite/create": patch
"@ifc-lite/export": patch
---

Reduce per-record attribute observer allocations and remove replaced authored geometry from the mutation journal without scanning unrelated session history. Bound the frozen entity snapshot memo while preserving held snapshots, exported mutations, detached drafts and compound undo order.

Enumerate created IDs without materializing attribute snapshots during export index and collision checks.
