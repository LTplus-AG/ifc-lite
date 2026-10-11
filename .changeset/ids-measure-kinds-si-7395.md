---
"@ifc-lite/ids": patch
"@ifc-lite/parser": patch
"@ifc-lite/viewer": patch
---

IDS property requirements now compare more measure values in SI, as IDS 1.0 requires. A type object's own property sets, and the measure attributes of predefined property sets such as `IfcDoorLiningProperties.LiningDepth`, now take the project unit like any other property. Measures outside length, area and volume now take their declared project unit as well: plane angle (degrees to radians), thermodynamic temperature (Celsius to kelvin, offset included), mass, time, force, power and the other dimensioned measures. A temperature with its own Celsius unit is converted too. Members of an `IfcPropertyTableValue`, or of a list that mixes types, are each converted by their own type. Previously every number got an extra length-scaled copy, so a raw millimetre value, or a scaled `IfcReal`, could satisfy a requirement. The parser reports these member types as `valueDataTypes`. An in-session correction to a property that declares its own `Unit` is now written and read back in that unit rather than the project's.
