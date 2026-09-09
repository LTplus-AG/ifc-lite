---
"@ifc-lite/parser": patch
---

Fix `SpatialHierarchyBuilder` dropping a real spatial subtree when a malformed `IfcRelAggregates` back-edge (a parent/child pair declared in both directions by mistake) is declared before the legitimate parent edge. `computeCanonicalParent` now skips any tied candidate parent that would close an aggregation cycle back through the child, instead of always taking whichever edge was declared first — so a genuine `IfcProject` anchor can no longer lose a tie to a spurious back-edge purely by STEP declaration order. A tied candidate that does not close a cycle (the pre-existing multiple-real-parents case, #4095) is unaffected. Each time a back-edge is skipped, a warning is logged naming the child and the disqualified candidate.
