---
"@ifc-lite/viewer": patch
"@ifc-lite/ids-authoring": patch
---

IDS Studio: picking a property's data type after its value now carries the data type's XSD base onto the value. A list of 1 to 5 typed before choosing IFCINTEGER was saved as `xs:restriction base="xs:string"`; it is now saved as `xs:integer`. The base moves only onto a numeric or string data type, and only when the value stays valid XSD under it; anything else (text on an integer, a boolean or date type, a pattern) is left as it was. `@ifc-lite/ids-authoring` exports the check as `rebaseRestriction`.
