---
'@ifc-lite/cli': patch
---

Fix `ifc-lite diff --by-content` reporting a re-exported model as `modified · data` on every measure-propertied element when only the project's declared length/area/volume unit changed. `Pset_*` `IfcPropertySingleValue`s typed `IfcLengthMeasure`/`IfcAreaMeasure`/`IfcPositiveLengthMeasure`/… now scale to base SI (via `@ifc-lite/parser`'s `scaleMeasureValue`) before hashing, the same way an `IfcElementQuantity` (`Qto_*`) quantity already did.
