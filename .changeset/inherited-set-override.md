---
"@ifc-lite/viewer": patch
---

Adding a property to a property set that an element only inherits from its type no longer creates a one-property set of that name on the element (#5966). The new occurrence set carries a copy of the type set's current values forward (value type and IFC data type kept), and the type's own set is left unchanged, so tools that let an occurrence set replace the type's set of the same name no longer show the other properties as lost. The Add property dialog says so when the chosen set is inherited, and the bSDD card follows the same rule. Each value reaches collaboration peers, and one Ctrl+Z removes the override. When the inherited set holds a property that cannot be copied exactly (multi-valued, or with its own unit), nothing is added and the message says why. IFC2X3 door and window styles are now read as type objects, so their sets are found too.
