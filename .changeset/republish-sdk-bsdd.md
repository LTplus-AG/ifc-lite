---
"@ifc-lite/sdk": minor
---

Publish the bSDD namespace and the IDS/performance work that landed in the SDK
since 1.15.0 but was never released.

The published `@ifc-lite/sdk@1.15.0` build predates three source changes
(#607 hot-path memoization, #615 the bSDD namespace, #623 IDS document auditing
and schema validation) because none of those PRs included a changeset bumping
`@ifc-lite/sdk`. As a result the registry build is missing the `BsddNamespace`
and `BsddHttpError` exports.

`@ifc-lite/mcp` imports `BsddHttpError` from `@ifc-lite/sdk`, so a fresh
`npx @ifc-lite/cli` (which depends on `@ifc-lite/mcp`) crashed at module load
with `does not provide an export named 'BsddHttpError'`. Releasing `@ifc-lite/sdk@1.16.0`
makes the existing `^1.15.0` ranges in the already-published `@ifc-lite/mcp` and
`@ifc-lite/cli` resolve to a build that has the export — no republish of those
two packages is required.
