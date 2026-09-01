---
'@ifc-lite/export': patch
---

Fix `ifc-lite convert --schema IFC2X3` (and any IFC4/IFC4X3 → IFC2X3 STEP export) replacing every `IfcDoorType`/`IfcWindowType` with an `IFCPROXY` carrying a freshly minted GlobalId, instead of mapping it to its real IFC2X3 target.

`IFC4_TO_IFC2X3` had no entry for `IFCDOORTYPE`/`IFCWINDOWTYPE`, so `convertStepLine` treated them as having no IFC2X3 representation at all and fell through to `resolveUnrepresentedEntity`'s IFCPROXY substitution — losing the door/window type's own GlobalId, Name, Description and property-set associations, even though IFC2X3 has a real target for both: `IfcDoorStyle`/`IfcWindowStyle`. Found round-tripping `AC20-FZK-Haus.ifc` (IFC4 → IFC2X3 → IFC4) and diffing against the source with `ifc-lite diff --by-content`: all 8 door/window type instances came back with a different GlobalId (added+deleted, not modified).

`IFC4_TO_IFC2X3` now maps `IFCDOORTYPE`/`IFCWINDOWTYPE` to `IFCDOORSTYLE`/`IFCWINDOWSTYLE`. Their attribute lists only partially overlap by name (IFC4 inserted `ElementType`/`PredefinedType` ahead of the attributes it kept), so a new `schema-converter-attr-remap.ts` reconciles them by attribute NAME rather than position, preserving `GlobalId`/`Name`/`Description`/`HasPropertySets`/`RepresentationMaps`/`Tag`/`OperationType`/`ParameterTakesPrecedence` and `$`-ing out only the attributes IFC2X3's `IfcDoorStyle`/`IfcWindowStyle` genuinely don't carry under that name. This is a deliberately narrow allowlist, not a general rule: any other cross-schema rename whose attribute lists aren't a strict positional prefix (e.g. `IFCBRIDGE` → `IFCBUILDING`) still passes its attributes through unchanged, as before.
