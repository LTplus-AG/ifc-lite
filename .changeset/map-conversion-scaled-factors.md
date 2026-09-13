---
"@ifc-lite/parser": minor
"@ifc-lite/server-client": minor
---

Read `IfcMapConversionScaled` FactorX, FactorY and FactorZ and apply them per axis before the rotation, as the Rust georeference does. `MapConversion` gains optional `factorX`, `factorY` and `factorZ`, and the server-client `Georeferencing` gains optional `factor_x`, `factor_y` and `factor_z` (absent in older server responses; treat a missing factor as 1). A non-finite factor refuses the whole conversion; a zero factor reads as 1.
