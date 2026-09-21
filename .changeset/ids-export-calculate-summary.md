---
'@ifc-lite/ids': minor
---

Export `calculateSummary` from `packages/ids/src/validation/validator.ts`
(issue #5138 PR 3). The viewer's rule engine is a second producer of
`ValidationReport`/`IDSValidationSummary` over the same general
`SpecificationResult[]` shape and needs the identical pass/fail-rollup
algorithm — one exported function instead of two copies that could drift.
Its parameter type widened from `IDSSpecificationResult[]` to
`readonly SpecificationResult[]` (a proper supertype, per the existing
`IDSSpecificationResult`-is-a-`SpecificationResult` narrowing), so every
existing call site keeps compiling unchanged.
