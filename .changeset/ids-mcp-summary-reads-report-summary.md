---
'@ifc-lite/mcp': patch
---

Fix `ids_validate`'s summary reporting a specification as failed when it legitimately passed while matching zero entities.

`summarizeIdsReport` cast the report to a hand-written minimal shape,
ignored `spec.status` entirely, and used `entityResults.length > 0` as the
pass condition for a specification. A specification with an explicit
`minOccurs="0"` (or a prohibited spec that correctly matches nothing) is a
legitimate pass with zero matched entities -- the validator's own
`report.summary` already gets this right, but the tool never read it.

`summarizeIdsReport` now projects `report.summary` directly instead of
re-deriving the counts, and the report parameter is typed as the real
`IDSValidationReport` rather than `unknown`, so there is no longer a
hand-written shape for the two to drift apart on.
