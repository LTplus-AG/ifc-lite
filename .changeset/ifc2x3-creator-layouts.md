---
"@ifc-lite/create": patch
---

`IfcCreator` with `Schema: 'IFC2X3'` now writes valid IFC2X3:

- Doors, windows, plates, members (including L/T/U profile members) and curtain walls use IFC2X3 attribute layouts, without the IFC4-only trailing attributes.
- Building element proxies write `$` for `CompositionType` instead of the invalid `.NOTDEFINED.`.
- Piles write `.NOTDEFINED.` instead of the IFC4-only `.DRIVEN.`.
- `IfcStyledItem` references an `IfcPresentationStyleAssignment`.
- The building gets its own placement instead of sharing the site's.

IFC4 and IFC4X3 output is unchanged.
