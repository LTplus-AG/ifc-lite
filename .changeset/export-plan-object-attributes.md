---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's Add can set an object's `LongName` (`with_long_name`, such as a space's room name beside its number in `Name`), `Tag` (`with_tag`) and `ObjectType` (`with_object_type`), and a new type's `Tag` and `ElementType` (`NewType::with_tag`, `NewType::with_element_type`). Values are written as STEP strings, escaped. A value is written only where the class has the attribute in the file's schema, and refused where it does not: `LongName` on a wall, `Tag` on a space, `ElementType` on an `IfcDoorStyle` (IFC2X3's door type, which is not an element type). A `USERDEFINED` `PredefinedType`, refused until now, is accepted when `ObjectType` (on an object) or `ElementType` (on a type) names the kind, and refused without one or with a blank one. `PropertyValue`, `NewProperty` and `NewPropertySet` keep their public paths. Plans that set none of these write the same bytes as before.
