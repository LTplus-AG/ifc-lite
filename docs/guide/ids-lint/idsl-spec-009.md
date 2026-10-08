<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-009: Duplicate identifier

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | document | yes |

Specification identifiers are how reports, BCF issues and contracts refer to a requirement. Two specifications sharing one identifier make those references ambiguous.

## Example

```xml
<specification identifier="FS-01" …/> twice
```

## Quick fix

Give the later specification a unique identifier. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-009` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
