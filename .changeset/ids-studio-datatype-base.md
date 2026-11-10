---
"@ifc-lite/viewer": patch
"@ifc-lite/ids-authoring": patch
---

IDS Studio: picking a property's data type after entering its value now saves the value with the data type's XSD base. A list of 1 to 5 typed before choosing IFCINTEGER was saved as `xs:restriction base="xs:string"`; it is now `xs:integer`. Picking a different data type later moves the base the same way. The base moves only when the new type can safely take the value; otherwise (a boolean or date type, text on an integer, a range on a text type, a pattern) the value keeps its old base. Picking the same data type again leaves an existing base alone. `@ifc-lite/ids-authoring` exports the check as `rebaseRestriction`.
