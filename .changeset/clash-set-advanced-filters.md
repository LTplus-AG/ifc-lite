---
'@ifc-lite/clash': minor
'@ifc-lite/viewer': minor
---

Clash rules can define each side with the viewer's advanced filter, not just a type selector (#3902).

A clash rule's A and B sets were one type-name pattern each (`IfcDuct*|IfcPipe*`), which cannot say "external walls" or "elements whose Pset_Revit_Phase.Phase is Existing". Each side of a rule may now carry a filter: the same rule rows the search panel offers — IFC type, name, predefined type, storey, elevation, property, quantity, material, classification — combined with AND or OR, edited with the same row components. The set is resolved with the same evaluator the search panel runs (`evaluateFilterRulesFederated`), so the two cannot drift apart.

`ClashRule` gains optional `membersA` / `membersB`: explicit `clashMemberKey(model, ref)` membership for a side, which replaces that side's selector when present. An empty list means the filter matched nothing and is deliberately distinct from an absent one, which still means "use the selector". A side with no filter, and every rule set saved before this, runs exactly as it did.
