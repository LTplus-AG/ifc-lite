---
"@ifc-lite/viewer": patch
"@ifc-lite/ids-authoring": patch
---

IDS Studio: picking a property's data type after entering its value now saves the value with the data type's XSD base. A list of 1 to 5 typed before choosing IFCINTEGER was saved as `xs:restriction base="xs:string"`; it is now `xs:integer`. Some values keep their old base, for example text under an integer type or a pattern. A list like this already saved as `xs:string` under IFCINTEGER shows the IDSL-VAL-002 warning, and its quick fix sets `xs:integer`. `@ifc-lite/ids-authoring` exports the check as `rebaseRestriction`.
