---
"@ifc-lite/ids": patch
---

An entity facet's `predefinedType` no longer falls back to the ObjectType when the element's PredefinedType is unset (#7394). IDS 1.0 lets the user-defined name stand in only for USERDEFINED, but a beam with PredefinedType `$` and ObjectType `X` passed a requirement for predefined type `X`. Such an element now fails as having no predefined type (`PREDEFINED_TYPE_MISSING`). The same rule applies to the entity nested in a `partOf` facet. A PredefinedType inherited from the type object, USERDEFINED with the type's ElementType included, is read as before, and so is an accessor that does not implement `getPredefinedTypeRaw`.
