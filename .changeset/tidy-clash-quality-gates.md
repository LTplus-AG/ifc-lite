---
"@ifc-lite/clash": patch
"@ifc-lite/cli": patch
---

Include model-qualified matched objects in rule coverage so object quality gates count federated models without conflating equal GlobalIds.

Keep clash findings for distinct objects whose exporter repeated a GlobalId, while preserving self-pair suppression for geometry parts sharing the same source object reference.
