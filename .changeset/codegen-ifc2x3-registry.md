---
'@ifc-lite/codegen': minor
'@ifc-lite/parser': minor
---

Bring IFC2X3 into `@ifc-lite/codegen` (#4202). `packages/codegen/schemas/`
now carries `IFC2X3_TC1.exp` (the official buildingSMART express longform
distribution) alongside the existing IFC4 and IFC4X3 schemas, and
`generateAll()` / `pnpm generate:ifc2x3` produce
`packages/codegen/generated/ifc2x3/` the same way the other two do — 653
entities, 327 types, 164 enums, 46 selects, with EXPRESS attribute types,
optionality, enum/select domains and inheritance chains, not just attribute
names. `scripts/check-codegen-sync.mjs` regenerates it in CI and fails the
build if the committed copy has drifted from `IFC2X3_TC1.exp`.

`IFC2X3_TC1.exp` is the first schema in this repo sourced with CRLF line
endings; committed normalized to LF (matching the other two) because a raw
`\r` inside a multi-line `SELECT` type's underlying-type string breaks the
generated `schema-registry.ts`'s string literal for `tsc`. It also has 12
`SET/LIST … OF UNIQUE` occurrences — the syntax #4212 is filed against for
IFC4/IFC4X3 — which the existing UNIQUE-stripping fix already handles
correctly for this schema too (zero `UNIQUE` leaks into the generated
output).

`@ifc-lite/parser` gains `getSchemaRegistryForVersion('IFC2X3' | 'IFC4' |
'IFC4X3')`, selecting the codegen-generated runtime registry by schema
version. `getSchemaRegistryForVersion('IFC4')` returns the exact
`SCHEMA_REGISTRY` object the package already exported, so every existing
caller's answer is unchanged. The lookup throws rather than returning an
empty registry if a version's `entities` map has zero keys, so a broken
regeneration reads as a thrown error, never as a silently empty result.
