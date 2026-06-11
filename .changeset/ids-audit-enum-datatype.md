---
"@ifc-lite/ids": patch
---

fix(ids): accept IFCLABEL for enumerated standard pset properties in the IDS audit.

The audit flagged `W_IFC_DATATYPE_MISMATCH` for any dataType declared on a
standard enumerated property (e.g. `Pset_ProjectCommon.ProjectType`,
`Pset_Address.Purpose`) because enumeration kinds carry no dataType in the
generated pset definitions. PEnum values serialize as IfcLabel, so IFCLABEL
is the canonical IDS dataType — upstream IdsLib's `HasDataTypes` maps
`EnumerationPropertyType` to `["IFCLABEL"]`, and authoring tools (ACCA
usBIM.IDS, IDSedit) emit IFCLABEL for these properties. A genuinely wrong
dataType on an enumerated property still errors, and the message now names
the expected type instead of "typed enumeration".

Property shapes with no known backing type (e.g. table values) are now
skipped instead of mismatching against every declaration, matching upstream
behavior when `HasDataTypes` returns false.
