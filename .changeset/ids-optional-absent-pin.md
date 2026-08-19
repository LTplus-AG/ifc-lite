---
'@ifc-lite/ids': patch
---

Add regression tests pinning `PSET_MISSING` and `PARTOF_RELATION_MISSING`
in `checkRequirement`'s `optional` allowlist (`packages/ids/src/validation/validator.ts`).

Per the IDS spec, `optional` means "if present, must satisfy" -- a
wholly-absent facet passes, a present-but-wrong facet fails. The allowlist
that implements this already covered eight failure-type codes, but two of
them -- `PSET_MISSING` (entity has no property sets at all) and
`PARTOF_RELATION_MISSING` (entity has no parent under the requested
relation at all) -- had no test forcing that exact shape, so either could
be silently dropped from the allowlist without failing `vitest run` or the
vendored buildingSMART corpus runner. Dropping either causes a
wrong-direction regression: entities that legitimately have nothing would
start failing an `optional` requirement instead of passing it.

No production logic changed. This also re-verifies the other six codes in
the same allowlist (`ATTRIBUTE_MISSING`, `PROPERTY_MISSING`,
`CLASSIFICATION_MISSING`, `MATERIAL_MISSING`, `PREDEFINED_TYPE_MISSING`,
`PARTOF_PREDEFINED_TYPE_MISSING`) individually against both suites; all
six were already pinned by at least one of `vitest run` or
`npm run test:ids-corpus`.
