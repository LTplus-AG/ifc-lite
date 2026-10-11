<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-003: Applicability that can never match

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | no |

All applicability facets must hold at once. Two of them constrain the same single-valued subject (two different entity classes, two disjoint values of one property) so no element can match, and the specification never applies.

## Example

```xml
<applicability><entity>IFCWALL</entity><entity>IFCSLAB</entity></applicability>
```

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-003` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
