<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-CARD-003: Prohibited specification with requirements

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

A prohibited specification (maxOccurs 0) says "no element may match the applicability". Its requirements are never evaluated, so they suggest a check that does not happen. buildingSMART marks this combination as invalid (corpus case ids/invalid-prohibited_specifications_invalid_if_requirements_are_specified).

## Example

```xml
<specification …><applicability minOccurs="0" maxOccurs="0">…</applicability><requirements>…</requirements></specification>
```

## Quick fix

Remove the requirements, or make the specification required. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-CARD-003` (or `IDSL-CARD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
