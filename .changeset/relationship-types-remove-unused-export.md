---
'@ifc-lite/parser': major
---

Remove the unused `RELATIONSHIP_TYPES` export. It carried a comment
asserting it "MUST include ALL RelationshipType enum values to prevent
semantic loss," but nothing in the codebase read the set — parsing is
actually gated by the internal `HIERARCHY_REL_TYPES` and
`PROPERTY_REL_TYPES` sets and by `REL_TYPE_MAP`.

Anyone importing `RELATIONSHIP_TYPES` directly should switch to
`REL_TYPE_MAP`, which this package still exports and which covers all 15
`RelationshipType` values. `HIERARCHY_REL_TYPES` and `PROPERTY_REL_TYPES`
are named above only to describe what really gates parsing — they are
internal to `columnar-parser-indexes.ts` and have never been part of this
package's public surface, so they are not available as a migration target.
