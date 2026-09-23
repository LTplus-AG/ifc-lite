---
"@ifc-lite/clash": patch
---

Fix a cross-group broad-phase dedup that could silently drop a real clash, order-dependently, when one entity spans several geometry sub-prims sharing a durable key (common in IFC5/USD). The broad phase now hands every candidate submesh pair to the narrow phase; identity-level dedup happens once, after the narrow phase has decided each submesh's verdict, keeping the more severe result.
