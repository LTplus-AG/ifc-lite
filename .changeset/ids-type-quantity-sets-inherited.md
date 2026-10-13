---
"@ifc-lite/ids": patch
---

IDS now sees the quantity sets a type object holds (#7542). `IfcTypeObject.HasPropertySets` lists `IfcElementQuantity` sets beside `IfcPropertySet`s, and IDS treats a quantity set as a property set, but the bridge read only the type's property sets. A requirement such as `Qto_WallBaseQuantities.Length` met only by the `IfcWallType` failed on its walls with the set reported missing, a property applicability on that quantity left those walls out, and the same requirement on the type object itself failed. Now:

- An occurrence inherits its type's quantity sets on both parse paths (the source-backed reader, and on a server-parsed store the quantity table under the type's id), converted to SI with the occurrence's project units or the quantity's own `Unit`.
- The occurrence's own quantity of the same name wins, and an occurrence set of the same name gains the type's other quantities: the per-item rule type property sets already follow.
- On a source-backed store, a type object checked directly reports its own quantity sets too. A server-parsed store already listed them under the type's own id.
- When an occurrence inherits them, a type quantity set named like one of the type's property sets adds the quantities that set lacks, and the property set keeps a same-named item, instead of being listed as a second set; a type object checked directly does the same on a source-backed store. Listed apart, each set would fail the other's requirements, and the property set's own requirements passed before.
- A quantity set attached to a type through `IfcRelDefinesByProperties` (which IFC2X3 and IFC4 forbid: an IFC2X3 type is not an `IfcObject`, and IFC4 has the rule `NoRelatedTypeObject`) is inherited too, as property sets attached that way already were.
- An in-memory property override (`createDataAccessor`'s `propertyOverlay`) of an inherited quantity now updates that quantity, converted by its measure type, instead of adding a new set that holds only the overridden quantity.
- `propertyValueToRaw` (`@ifc-lite/ids/bridge`, used for correction writes) now finds an inherited type quantity, so a correction to it is converted back by that quantity's own `Unit` when it has one, as a type property set with its own `Unit` already was (#7395).
