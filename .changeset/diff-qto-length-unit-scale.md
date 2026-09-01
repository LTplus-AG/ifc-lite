---
'@ifc-lite/cli': patch
---

Fix `ifc-lite diff` reporting a `Qto_` `IfcElementQuantity` (Length/Area/Volume) as `modified` when a model is re-authored in a different project length unit but no physical quantity actually changed.

`buildFileFingerprints`' data input built each quantity's `dataHash` contribution from the raw parser value — the project's own author-unit number, exactly like an untyped `IfcPropertySingleValue`. A wall re-exported from a metre-authored file (`IfcQuantityLength` `2`) into a millimetre-authored one (`2000`), with no edit to the design, therefore hashed to two different values and the entity classified as `modified · data`. Quantities are now scaled to base SI with `quantitySiScale` (`@ifc-lite/parser`) before rounding and hashing, mirroring the base-SI conversion `#3458` already applied on the IDS comparison path.
