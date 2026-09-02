---
'@ifc-lite/parser': minor
---

New export `scaleMeasureValue(value, dataType, projectUnits)`: scales a property value declared with a project-scoped IFC measure type (`IfcLengthMeasure`, `IfcAreaMeasure`, `IfcPositiveLengthMeasure`, …) to base SI, using `ProjectUnits.unitForMeasure`. A no-op for a value with no numeric type, no `dataType`, or a `dataType` with no project-scoped unit.

Added to fix a false positive in every model-diff adapter (`ifc-lite diff --by-content`, the viewer's compare panel, `model_diff`): an `IfcPropertySingleValue` measure is stored in the project's raw author unit exactly like an `IfcElementQuantity` (`Qto_*`) quantity, which the diff engine's quantity path already scaled — nothing scaled the property path. A wall re-exported from a metre-authored file into a millimetre-authored one, with no design edit at all, hashed to two different `dataHash` values and was reported `modified · data` on every measure-propertied element in the model.
