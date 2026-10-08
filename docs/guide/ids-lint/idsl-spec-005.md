<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-005: Duplicate specification

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | document | yes |

Two specifications have the same IFC versions, applicability, requirements and cardinality (names and descriptions aside). Every element is checked twice and reported twice, and an edit to one copy silently diverges from the other.

## Example

```xml
Two <specification> elements with identical content and different names.
```

## Quick fix

Remove the later copy. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-005` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
