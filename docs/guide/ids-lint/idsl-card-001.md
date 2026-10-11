<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-CARD-001: Prohibited requirement with a value or data type

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

A prohibited facet with a value can be read two ways: "must not have this property at all" or "must not have it with this value". Tools disagree (IDS issues #206 and #420), so the same file passes in one checker and fails in another. Without a value the meaning is unambiguous.

## Example

```xml
<property cardinality="prohibited">…<value><simpleValue>EI30</simpleValue></value></property>
```

## Quick fix

Drop the value and data type, so the requirement reads "must not have it at all". The other reading cannot be expressed unambiguously in IDS 1.0. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## References

- <https://github.com/buildingSMART/IDS/issues/206>
- <https://github.com/buildingSMART/IDS/issues/420>

## Suppressing

Add a suppression with a reason for `IDSL-CARD-001` (or `IDSL-CARD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
