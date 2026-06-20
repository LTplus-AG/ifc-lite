---
"@ifc-lite/viewer": patch
---

Fix `this.store.getQuantities is not a function` crash when selecting an
entity in an IFCX-imported model. The IFCX ingest built a populated data
store but never attached the lazy accessor methods
(`getQuantities`/`getProperties`/`getEntity`) the query/selection path
calls — it now routes the store through `attachDataStoreAccessors`.
