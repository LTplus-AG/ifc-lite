---
"@ifc-lite/viewer": patch
"@ifc-lite/ids-authoring": patch
---

IDS Studio: picking a property's data type after its value now carries the data type's XSD base onto the value. A list of 1 to 5 typed before choosing IFCINTEGER was saved as `xs:restriction base="xs:string"`; it is now saved as `xs:integer`. A value that does not hold under the new base (text on an integer, a fractional bound) is left as it was. `@ifc-lite/ids-authoring` exports the check as `rebaseRestriction`.
