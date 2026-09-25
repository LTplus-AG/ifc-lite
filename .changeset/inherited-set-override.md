---
"@ifc-lite/viewer": patch
---

Adding a property to a property set that an element only inherits from its type no longer creates a one-property set of that name on the element (#5966). The new occurrence set carries the type set's properties forward, and the type's own set is left unchanged, so tools that let an occurrence set replace the type's set of the same name no longer show the other properties as lost. The Add property dialog says so when the chosen set is inherited, and the bSDD card follows the same rule.
