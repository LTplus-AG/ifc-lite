<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-007: Specification without requirements

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | no |

A specification with no requirements only checks whether applicable elements exist (when it is required), or checks nothing at all (when it is optional). That is sometimes intended, but often a requirement was forgotten. Prohibited specifications are exempt: "no element may match" needs no requirements.

## Example

```xml
<specification …><applicability>…</applicability></specification>
```

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-007` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
