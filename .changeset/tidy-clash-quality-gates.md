---
"@ifc-lite/clash": major
"@ifc-lite/cli": patch
---

Include model-qualified matched objects in rule coverage so object quality gates count federated models without conflating equal GlobalIds.

Keep clash findings for distinct objects whose exporter repeated a GlobalId, while preserving self-pair suppression for geometry parts sharing the same source object reference.

Breaking change: clash IDs involving repeated GlobalIds now include entity references to distinguish those objects. Comparisons against runs saved with the previous IDs may report resolved and added findings; establish a new baseline after upgrading. IDs for objects with unique GlobalIds remain unchanged.
