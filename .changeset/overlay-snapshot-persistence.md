---
"@ifc-lite/mutations": minor
---

Persist and restore versioned overlay snapshots with source-content identity checks, logical row coordinates, optional host undo stacks, and atomic replacement. Created entities, skip-history edits, forgotten creation rows and the allocator survive persistence; derived indices are rebuilt. Caller-supplied full-source hashes prevent applying IDs to a different source. Existing journal-only export/import remains available.
