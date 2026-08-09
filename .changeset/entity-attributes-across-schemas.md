---
"@ifc-lite/parser": patch
---

`extractAllEntityAttributes` now names attributes across the bundled schema union (IFC2X3 + IFC4 + IFC4X3) instead of through the IFC4 codegen pin alone, so an entity of an IFC4.3 infrastructure class stops reporting no attributes at all.

The pin answers an **empty** attribute list — not a wrong one — for every class it does not carry, and 251 real classes are outside it: the IFC2X3 ones IFC4 dropped, and the whole IFC4.3 infrastructure vocabulary (`IfcCourse`, `IfcPavement`, `IfcKerb`, `IfcSignal`, `IfcRail`, `IfcRoad`, `IfcBearing`, …). Empty is the damaging shape: a caller looking an attribute up by name finds nothing, and nothing is indistinguishable from an unset slot, so every consumer answered "absent" with no error and no diagnostic. The same pinned-registry family as the membership defects #2001, #2003 and the `Tag` defect #2021, which fixed one lookup this way and left the general one.

The consumer where it was measurable is the model diff. Both fingerprint adapters (`@ifc-lite/cli`'s and the viewer's) read `PredefinedType` through this function, so on an IFC4.3 element the attribute was absent from the fingerprint on **both** revisions and a cleared or changed `PredefinedType` compared equal to itself. On an infrastructure revision pair whose products were compared against an independent parse of the raw STEP text, a cleared `PredefinedType` was the *only* edit on 19 of 23 modified products — a comparison blind to it under-reports by roughly a factor of four while looking healthy. `@ifc-lite/ids`' `PredefinedType` facet and the viewer's PredefinedType display read the same function and had the same hole.

Provably additive rather than a re-resolution: `getAttributeNamesAcrossSchemas` returns the pinned result unchanged whenever the pin has one, so no IFC2X3 or IFC4 entity's attribute list moves — and neither does any diff fingerprint, identity-map entry or exported value derived from one. Measured on a real IFC4 revision pair: the added / deleted / modified GlobalId sets are byte-identical before and after.

Two sibling lookups in the same file still go through the pin and are deliberately left alone: `getRawNamedAttributes` (the query layer's coercion path) and `getRootAttrIndices`, whose `known` flag gates columnar `EntityTable` membership and so has a materially larger blast radius than an attribute read.
