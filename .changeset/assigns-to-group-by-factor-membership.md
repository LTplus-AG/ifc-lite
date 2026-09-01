---
'@ifc-lite/parser': patch
---

Fix `IfcRelAssignsToGroupByFactor` (the proportional-factor subtype of `IfcRelAssignsToGroup`) being silently dropped from the relationship graph. It matched none of the parser's relationship-type gates (`RELATIONSHIP_TYPES` / `HIERARCHY_REL_TYPES` / `REL_TYPE_MAP`) or the `extractRelFast` byte scanner, so an element assigned to a zone/system exclusively through this relationship never appeared in that group's members, and the group never appeared in the element's own group list. `extractGroupMembersOnDemand` and `extractRelationshipsOnDemand` now resolve both relationship kinds.
