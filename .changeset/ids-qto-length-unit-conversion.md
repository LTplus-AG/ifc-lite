---
'@ifc-lite/ids': patch
---

Fix IDS `<property>` requirements against `IfcElementQuantity` (`Qto_*`) length quantities comparing the raw author-unit value instead of the base-SI value the IDS literal is always expressed in.

`collectAllPropertySets` already converted `IfcPropertySet` (`Pset_*`) length-typed values through `projectProperty`/`applyUnitConversion` before handing them to the validator, but `appendQuantitySets` built its quantity values directly from the raw parser record and skipped that step. On a millimetre-authored model, an `IfcQuantityLength` stored as `2000` (2 metres) compared against an IDS literal of `2` — which per the spec is always base SI — and the requirement false-failed even though the model complies. `appendQuantitySets` now routes every quantity through `projectProperty` with the project's `lengthUnitScale`, matching the property path.
