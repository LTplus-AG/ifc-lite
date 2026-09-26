---
"@ifc-lite/ids": minor
---

Property facet checking now matches upstream ifctester (IfcOpenShell) in three cases (#6117):

- A string-typed value (`IfcLabel`/`IfcText`/`IfcIdentifier`, or a plain-string accessor value under a string-typed `dataType` facet) now compares as an exact string instead of falling back to numeric tolerance: a value of `IFCLABEL('1.0000001')` now correctly **fails** a requirement value of `1` (previously passed). This is decided by the value's EXPRESS base (`IfcDate`/`IfcDateTime`/`IfcDuration` are EXPRESS STRING and are now correctly exact-string too, even in an `<enumeration>` requirement, which had no cast-gate protection); an unrecognised `dataType` name also falls to exact-string rather than to coercion.
- A property `baseName`/`propertySet` `<simpleValue>` with leading/trailing whitespace is kept verbatim instead of trimmed, so a property named `' Spaced'` is now found (previously reported "not found"). The same fix applies to a bare `<xs:restriction>` value with no `<pattern>`/`<enumeration>`/bounds child (e.g. `<xs:restriction base="xs:string"> Foo </xs:restriction>`).
- A property whose value is empty (`''`), null/undefined, or the `IfcLogical` `UNKNOWN` state is now treated as absent under `optional` cardinality, so it **passes** (previously failed with "must have a value, got (empty)"). `prohibited` already passed; the default `required` cardinality still fails, unchanged.
