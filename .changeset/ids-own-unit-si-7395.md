---
"@ifc-lite/ids": patch
---

IDS property requirements now compare a property or quantity that declares its own `Unit` in SI, using that unit rather than the project's unit assignment. For example, `IFCPROPERTYSINGLEVALUE('Wall Thickness',$,IFCLENGTHMEASURE(100.),#9)` with `#9` a millimetre unit, in a metre project, now satisfies a requirement of `0.1` instead of being compared as 100 m. This covers instance, type-inherited and material property sets, list values and `IfcElementQuantity` quantities. A value whose own unit cannot be resolved is left as written rather than rescaled by the project factor. Temperature and monetary measures keep their raw value.
