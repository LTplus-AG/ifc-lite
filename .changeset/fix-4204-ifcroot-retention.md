---
"@ifc-lite/parser": patch
---

The columnar parser now retains every `IfcRoot` descendant in the `EntityTable`, derived from the schema registry's inheritance chain, in addition to `IfcProduct` subtypes, `IfcGroup` subtypes and anything named `IfcRel*`. `IfcTask`, `IfcActor`, `IfcCostItem`, `IfcResource`, `IfcStructural*`, `IfcProjectLibrary`, `IfcPropertySetTemplate` and other non-product `IfcObject`/`IfcContext`/`IfcPropertyTemplateDefinition` classes previously fell to `CAT_SKIP` and were unaddressable: `getGlobalId` and `getTypeName` answered `''` and `'Unknown'` for them even though the scanner's byId/byType index still saw the record.

The original `IfcRel*` name-prefix test is kept alongside the new schema-derived check, not replaced by it: it still matches lexically for `IfcRelaxation` (a real IFC2X3 material-property-resource entity, not a relationship, that is not an `IfcRoot` descendant) and for any vendor extension named `IfcRel*` that the bundled schema registry doesn't know at all, both of which the schema-derived check alone would miss. A schema-registry sanity check now throws rather than parsing silently if the inheritance walk ever fails to reach `IfcRoot`.
