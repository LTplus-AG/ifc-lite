---
'@ifc-lite/ids': major
---

Generalise the validation report shape (issue #5138) so a future rule-set
("information validation") engine can share it with IDS validation.

**Breaking**: `IDSValidationReport.document` moved to `source.document`
(`source: { kind: 'ids'; document: IDSDocument }`), and `modelInfo` is now
an array (`ValidationModelInfo[]`) instead of a single object. JSON exports
of a report now include `source`/`modelInfo` in the new shape.

Added exports: `ValidationSource`, `SpecificationSummary`,
`RequirementSummary`, `CheckKind`, `FailureReasonCode`, `SetResult`,
`RequirementResult`, `EntityResult`, `SpecificationResult`,
`ValidationReport`, `ValidationModelInfo`.

`IDSSpecificationResult`, `IDSEntityResult`, `IDSRequirementResult` and
`IDSModelInfo` are unchanged in spirit (kept as narrowings/aliases of the
new general types) — existing IDS-only code keeps working once the report
literals it builds carry `source`/`modelInfo[]` instead of
`document`/`modelInfo`.
