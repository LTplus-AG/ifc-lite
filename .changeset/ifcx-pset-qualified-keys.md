---
"@ifc-lite/export": minor
"@ifc-lite/ifcx": minor
"@ifc-lite/collab": patch
---

IFCX export no longer silently merges same-named properties from different property sets (#5376). Before this change, every pset property went out under `bsi::ifc::prop::<Name>`, which has no pset component. Two psets on one entity that shared a name wrote the same key, the last value won, and on import the pset each property came from could not be recovered.

- With `onlyKnownProperties: false` (full fidelity, used by Export Changes), every pset property is now written under `bsi::ifc::v5a::<Pset>::<Name>` as a typed `{ type, value }` record. This is the pset-qualified form collab snapshots and MCP draft ops already write, so nothing is lost, and re-import restores each pset with its real name.
- The flat `bsi::ifc::prop::<Name>` key is still written, but only for names the official IFC5 property schema (`prop@v5a.ifcx`) defines, so standard IFCX consumers still find them. Custom names such as `Reference` no longer get a flat key the schema does not define.
- `Ifc5ExportResult.stats.propertyCollisions` lists every official flat key that two psets on one entity disagreed on. `valueLost` is true when only the flat key was written (`onlyKnownProperties: true`), which means one value is missing from the file. The viewer's IFCX export toast now reports lost values.
- On import, `@ifc-lite/ifcx` skips a flat key that only mirrors a pset-qualified value on the same node, so the property is not listed twice.
- `PROPERTY_TYPE_NAMES` (`PropertyValueType` → IFC defined type name for typed records) now lives in `@ifc-lite/ifcx`, shared by the exporter and collab. `@ifc-lite/collab` still re-exports it.

Files written before this change still read the same: their flat keys land in "IFC Properties", as before.
