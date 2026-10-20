---
'@ifc-lite/export': minor
---

The flat data exports (CSV, JSON, JSON-LD, IFCX, USD, Parquet BOS and the Python `entity_data`) now write every property kind. Enumerated, list, bounded, table, reference and complex properties used to be dropped without a warning, so a property set could arrive with only its single values. Each one is now written as the display string the viewer shows, typed as text, with its value type set to the members' shared type tag or else the property class. Single values are unchanged.
