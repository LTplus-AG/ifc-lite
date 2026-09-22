---
"@ifc-lite/export": patch
---

Fix a schema-conversion downgrade from IFC4X3 (or IFC5) to IFC4 leaving `$` in an attribute slot IFC4 declares mandatory but the source schema made optional — e.g. `IfcProjectedCRS.Name` — producing a file invalid against the schema its own header declares (#5202). A downgrade to IFC2X3 already had this guard (`Ifc2x3SlotFill`, #4714); this adds its IFC4 twin, generated from the same EXPRESS-derived registry the IFC2X3 table comes from. Booleans get the schema's own "claims nothing" value (`.F.`); every other required slot with no honest default (measures, labels, identifiers, entity references, and every enum) is left as `$` and counted, so callers can tell the file is not valid IFC4 instead of receiving an invented value. Schema-conversion enum-member reconciliation (a different gap #5202 also reports) is not addressed by this change.
