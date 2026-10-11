<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-REGEX-004: Catastrophic backtracking risk

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | no |

The pattern has a shape (nested or overlapping quantifiers, excessive length) that the shared ReDoS guard rejects: a backtracking engine can take exponential time on it. ifc-lite refuses to run it, and other checkers may hang.

## Example

```xml
<xs:pattern value="(a+)+b"/>
```

## Suppressing

Add a suppression with a reason for `IDSL-REGEX-004` (or `IDSL-REGEX-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
