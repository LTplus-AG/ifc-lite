---
'@ifc-lite/charts': minor
'@ifc-lite/data': minor
'@ifc-lite/mutations': minor
'@ifc-lite/parser': minor
'@ifc-lite/query': patch
---

Let element charts bind to an exact IFC attribute or property, persist the field interpretation, normalize scalar values for aggregation, and report missing sum contributions. Resolve named attributes across every bundled IFC schema so IFC2X3-only and IFC4X3-only classes participate too (`EntityNode.allAttributes()` now consults the store's own schema version). On-demand property extraction reports a property's explicit `Unit` as `unit` plus `unitSiScale`; an unresolvable unit reference is reported as `#<id>` with no scale instead of being dropped.
