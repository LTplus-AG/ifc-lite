---
"@ifc-lite/data": minor
"@ifc-lite/viewer": minor
---

Add `collectSpatialAncestors` (`@ifc-lite/data`) — the shared upward-traversal resolver for the IfcOpenShell selector's `parent=` construct, walking both spatial containment (`IfcRelContainedInSpatialStructure`) and aggregation (`IfcRelAggregates`) edges to any depth, cycle-safe against a malformed file.

The viewer's selector adapter (`selector-to-rules.ts`) and Filter tab now support `parent=Foo` as a new `parent` `FilterRule` kind instead of refusing it: an element matches when any spatial ancestor's `Name` satisfies the operator (bare, regex, `!=`), and a name no ancestor has reads as an empty result, not "no filter". `query:` value queries remain refused, now documented as deliberately out of scope rather than "not supported yet".
