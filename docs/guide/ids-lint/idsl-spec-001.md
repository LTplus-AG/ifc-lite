<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-001: Requirement that can never fail

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The requirement asks for something the applicability already guarantees: the same entity, attribute or property with the same or a weaker constraint. Every applicable element satisfies it by construction, so it checks nothing. Usually the facet belongs in only one of the two sections.

## Example

```xml
<applicability>…<property>…<value><simpleValue>EI60</simpleValue></value></property></applicability><requirements><property>… (same property, no value)</property></requirements>
```

## Quick fix

Remove the requirement. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-001` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
