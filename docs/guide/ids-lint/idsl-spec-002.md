<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-002: Contradictory requirements

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | no |

Two constraints on the same single-valued subject (the entity class, one attribute, one property) have no value in common: two requirements with disjoint enumerations or bounds, or a requirement that excludes every value the applicability selects. No element can pass. The solver only reports a contradiction it can prove (finite sets and numeric ranges exactly; patterns are never declared disjoint).

## Example

```xml
<requirements><property>…<value><simpleValue>EI60</simpleValue></value></property><property>… (same property) <value><simpleValue>EI90</simpleValue></value></property></requirements>
```

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-002` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
