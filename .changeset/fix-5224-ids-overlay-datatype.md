---
'@ifc-lite/ids': minor
'@ifc-lite/parser': minor
'@ifc-lite/data': minor
'@ifc-lite/server-client': minor
---

An IDS property facet that requires a `dataType` now **fails** when the property's dataType is unknown, instead of skipping the check (#5224). A spec that demanded `IFCBOOLEAN` used to pass `"not-a-boolean-at-all"` whenever the stored property carried no dataType.

- `@ifc-lite/ids`: the new failure type `PROPERTY_DATATYPE_UNKNOWN` holds under every optionality, `prohibited` included, so "cannot verify" is never a pass. It has messages in both formatters and in en/de/fr. Only a property flagged `dataTypeMixed` (an `IfcPropertyTableValue`, whose columns differ in type by design) is exempt, and it defers to the value match, as upstream ifctester does. The property overlay resolver no longer manufactures `''` for a correction created without a dataType. `PropertySetInfo` properties now type `dataType` as `string | undefined` and gain `dataTypeMixed`. A predefined property set's attributes (`IfcDoorPanelProperties.PanelOperation`, …) take their declared EXPRESS type as their dataType.
- `@ifc-lite/parser`: `IfcPropertyListValue` and `IfcPropertyEnumeratedValue` carry the one `dataType` their members share, and a table sets `dataTypeMixed`. The new export `getAttributeTypeForSchema` returns an attribute's declared EXPRESS type.
- `@ifc-lite/data`: `Property` gains `dataTypeMixed`.
- `@ifc-lite/server-client`: `Property` gains `data_type_mixed`, decoded from the server's new `data_type_mixed` column (data-model payload v7).
