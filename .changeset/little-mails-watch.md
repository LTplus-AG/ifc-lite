---
"@ifc-lite/mutations": patch
"@ifc-lite/create": patch
---

Reduce per-record attribute observer allocations and remove replaced authored geometry from the mutation journal without scanning unrelated session history. Bound the frozen entity snapshot memo while preserving held snapshots, exported mutations, detached drafts and compound undo order.
