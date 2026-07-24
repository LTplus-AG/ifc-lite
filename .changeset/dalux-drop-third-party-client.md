---
"@ifc-lite/source-dalux": major
---

Drops the `dalux-build-api` runtime dependency. The package now has no runtime
dependencies beyond `@ifc-lite/plugin-api`.

The provider previously borrowed types and zod schemas by deep-importing that
client's `src/` internals, which coupled a published `@ifc-lite/*` package to
another package's private module layout, and pulled zod into the viewer's
eagerly loaded bundle for what amounts to a few dozen field checks. Response
shapes are now hand-written interfaces with explicit decoders in
`src/dalux-types.ts`, matching how the sibling SharePoint/OneDrive provider
talks to Microsoft Graph.

This is a dependency change, not a behaviour change: the decoders reproduce the
previous schemas' semantics exactly — non-strict objects, `nullish` fields
accepting both an absent key and an explicit `null`, `deleted` defaulting to
`false`, and a present-but-wrong-typed field being rejected rather than
coerced — and are covered by their own tests.
