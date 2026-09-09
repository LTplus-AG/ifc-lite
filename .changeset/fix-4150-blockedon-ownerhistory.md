---
'@ifc-lite/cli': patch
---

extract-entities: only force-keep a dropped spatial relation's blockers when every one of them is a defined `IfcOwnerHistory` (#4150).

`planSpatialRelations` reported the unkept non-SET references of a relation it dropped for that reason alone, and `buildSubset` closed over all of them. On schema-invalid input that over-extracted in two ways: a relation blocked on both a real private `IfcOwnerHistory` and a phantom id still dropped in the replan, but the owner subtree was kept and emitted as records nothing references; and a bare product reference in a `Name` or `Description` slot pulled that product's whole closure in, which could resurrect an unrelated containment whose member intersection had been empty. Blockers are now grouped per relation, and a group is closed over only when it resolves entirely, so the relation it belongs to actually survives the replan. Valid input is unaffected, and the private-`IfcOwnerHistory` rescue from #4126 still works, including alongside a relation whose blockers do not resolve.
