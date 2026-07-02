---
"@ifc-lite/ifcx": patch
---

fix(ifcx): guard PathIndex hierarchical indexing against child cycles

`PathIndex.indexHierarchicalPaths` recursed through a node's children with no
ancestor tracking, so a malformed IFCX layer with a child cycle (`A -> B -> A`)
recursed until the stack overflowed and crashed the load. The recursion now
tracks the uuids on the current DFS branch and skips a child that is already an
ancestor; a node reached by two distinct non-ancestral paths (a diamond) is
still indexed under both.
