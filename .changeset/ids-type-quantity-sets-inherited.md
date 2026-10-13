---
"@ifc-lite/ids": patch
---

IDS now sees the quantity sets a type object holds (#7542). `IfcTypeObject.HasPropertySets` lists `IfcElementQuantity` sets beside `IfcPropertySet`s, and IDS treats a quantity set as a property set. The bridge read only the type's property sets. So a requirement such as `Qto_WallBaseQuantities.Length` met only by the `IfcWallType` failed on its walls, with the set reported missing. A property applicability on that quantity left those walls out. The same requirement on the type object itself failed. Now:

- An occurrence inherits its type's quantity sets on both parse paths. These are the source-backed reader, and on a server-parsed store the quantity table under the type's id. They are converted to SI with the occurrence's project units, or with the quantity's own `Unit`.
- The occurrence's own quantity of the same name wins. An occurrence set of the same name gains the type's other quantities. This is the per-item rule type property sets already follow.
- On a source-backed store, a type object checked directly reports its own quantity sets too. A server-parsed store already listed them under the type's own id. One exception: a type that also has a set attached through `IfcRelDefinesByProperties` reports only that set on itself. Its property sets already behave this way, so that is left to a separate issue.
- A type quantity set named like one of the type's property sets adds the quantities that set lacks. The property set keeps a same-named item. Before, the quantity set was not read at all. Listed as a second set, each set would fail the other's requirements. This holds when an occurrence inherits them, and for a type object checked directly on a source-backed store.
- A quantity set attached to a type through `IfcRelDefinesByProperties` is inherited too, as property sets attached that way already were. IFC2X3 and IFC4 forbid that attachment. An IFC2X3 type is not an `IfcObject`, and IFC4 has the rule `NoRelatedTypeObject`.

Corrections (`propertyValueToRaw` in `@ifc-lite/ids/bridge`, and an in-memory override through `createDataAccessor`'s `propertyOverlay`):

- One rule now sets the unit of a correction. The viewer writes a correction through `MutablePropertyView.setProperty`. That edits in place a property the entity's own property sets hold. For any other entry it writes a new property with no unit. So a correction to such an entry is written and read back in the entity's project unit, not in the entry's own `Unit`. These entries are every quantity and every entry inherited from the type. Every quantity means the occurrence's own, an inherited one, and a type object's own.
- This changes two existing cases. A correction to an inherited property with its own `Unit` was converted into that unit (since #7395). So was a correction to an occurrence's own quantity with its own `Unit`. In both, the exported file was off by that unit's factor.
- A property an entity holds in its own property set keeps its own `Unit` for a correction, as before (#7395). The viewer edits that property in place.
- A second override of the same entry also reads in the project unit.
- An override of an inherited quantity, or of a quantity of a type object checked directly, now updates that quantity, converted by its measure type. Before, it did not find the quantity. Where the entity had no set of that name, it added a new set holding only that quantity. Where the occurrence had its own set of that name, it added the quantity to that set. Both converted by the override's `dataType`, and left the value as written when it had none.
- An override that deletes an inherited quantity now removes it. The set stays with no items, as it does for a deleted inherited property. So a requirement on that quantity fails with `PROPERTY_MISSING`, where before it failed with `PSET_MISSING`.
- `propertyValueToRaw` now finds these quantities. Without a `dataType` it converts by the quantity's measure type. Before, it returned the value unchanged. With a `dataType` the result for these quantities is unchanged.
