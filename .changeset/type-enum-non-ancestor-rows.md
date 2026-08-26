---
'@ifc-lite/data': patch
---

Three IFC classes are no longer reported as a different IFC class.

`IfcTypeEnum` covers a fraction of the schema, so the table behind `IfcTypeEnumFromString` deliberately coalesces some classes onto a coarser one — `IFCDOORSTANDARDCASE` resolves to `IfcDoor`, which is lossy but sound because a door standard case is a door. Three rows pointed somewhere else entirely:

- `IfcTendonAnchor` → `IfcTendon` — siblings under `IfcReinforcingElement`.
- `IfcFastener` → `IfcMechanicalFastener` — the key's own child, so a plain fastener was reported as the narrower mechanical one.
- `IfcCableCarrierSegment` → `IfcCableSegment` — siblings under `IfcFlowSegment`; the tray was reported as the cable it holds.

`entities.getTypeName()` returned the wrong class for all three, which the Parquet exporter writes into its `Type` column. The rows are removed, so those classes fall through to the raw parsed name and keep their own spelling. A new test sweeps the whole table against the bundled IFC2X3/IFC4/IFC4X3 registries and fails any row whose key is not the class it resolves to or one of that class's ancestors, so this cannot come back under a different spelling.
