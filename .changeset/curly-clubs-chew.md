---
"@ifc-lite/create": major
---

Validate space classification against its IFC schema before writing and keep Pset_SpaceCommon.IsExternal consistent with EXTERNAL spaces.

The surviving addSpaceToStore API now refuses schema-invalid classification values and USERDEFINED spaces without ObjectType before any write. This widens its runtime error contract; the major release makes that change explicit to existing callers.
