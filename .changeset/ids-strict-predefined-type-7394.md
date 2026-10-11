---
"@ifc-lite/ids": patch
---

IDS predefined types now follow IDS 1.0 strictly (#7394).

- Entity facet `predefinedType`: the `ObjectType` (or a type object's `ElementType`) stands in for the predefined type only when the applicable `PredefinedType` is `USERDEFINED`. An element whose `PredefinedType` is unset or `NOTDEFINED` no longer matches a custom value through its `ObjectType`. The applicable `PredefinedType` is the type object's when it defines one (anything but unset or `NOTDEFINED`), else the occurrence's, and the user-defined name is read from that same entity.
- Attribute facet `name=PredefinedType`: reads the `PredefinedType` attribute as stored on the entity. It no longer resolves to the `ObjectType` or to the type object's value, so an unset `PredefinedType` is a missing attribute and a `USERDEFINED` one has the value `USERDEFINED`.

Models that relied on the old fallback, with a custom value in `ObjectType` but no `PredefinedType` of `USERDEFINED`, may now fail requirements that used to pass. Set `PredefinedType` to `USERDEFINED` on those elements (or their type objects).
