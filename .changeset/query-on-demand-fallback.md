---
"@ifc-lite/query": patch
"@ifc-lite/parser": patch
---

Surface on-demand properties and quantities through the query API.

`parseColumnar` intentionally leaves the pre-parsed `store.properties` / `store.quantities` tables empty and populates `onDemandPropertyMap` / `onDemandQuantityMap` instead, but `QueryResultEntity` only read from the empty pre-parsed tables. As a result `query.ofType(...).includeProperties().includeQuantities().execute()` always returned elements with empty `properties` / `quantities`, even when the IFC file contained them (issue #577).

`loadPropertiesFromStore` / `loadQuantitiesFromStore` in `query-result-entity.ts` now fall back to `extractPropertiesOnDemand` / `extractQuantitiesOnDemand` when the pre-parsed tables are empty and the on-demand maps are present. This applies to the `properties` / `quantities` getters, the `loadProperties` / `loadQuantities` eager loaders, and the `getProperty()` accessor.

Also normalizes untagged STEP enumeration tokens (`.T.` / `.F.` / `.U.` / `.X.`) emitted by some authoring tools in the `NominalValue` slot of `IfcPropertySingleValue`: `.T.` / `.F.` now decode to real JS booleans and `.U.` / `.X.` to a Logical `null`, matching the behavior of the conformant `IFCBOOLEAN(...)` / `IFCLOGICAL(...)` typed form.
