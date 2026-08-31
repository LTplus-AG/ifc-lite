---
'@ifc-lite/parser': patch
---

Fix eight `IfcTypeProduct`/`IfcGrid`/`IfcPath`/etc. attributes carrying a
stray `UNIQUE` keyword (or a dropped array dimension) in `SCHEMA_REGISTRY`'s
attribute-type metadata, from a stale `packages/codegen` regeneration.
`entities.ts`'s TypeScript interfaces had been hand-patched to valid syntax
in a prior commit, but `schema-registry.ts` — same bug, but a string value
rather than a type, so `tsc` never caught it — still reported
`type: 'UNIQUE IfcGridAxis'` for `IfcGrid.UAxes`/`VAxes`/`WAxes` and seven
other attributes, and `type: 'number'` (missing a dimension) for
`IfcStructuralLoadConfiguration.Locations` instead of `IfcLengthMeasure[][]`.
See the `@ifc-lite/codegen` changeset in this release for the generator fix
and the full attribute list.
