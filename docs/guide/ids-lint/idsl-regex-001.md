<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-REGEX-001: ^ or $ in an XSD pattern

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

XSD patterns are implicitly anchored: the whole value must match. "^" and "$" are not anchors there but ordinary characters, so "^EI.*$" only matches values that literally start with "^" and end with "$".

## Example

```xml
<xs:pattern value="^EI[0-9]+$"/>
```

## Quick fix

Remove the leading ^ and trailing $. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## References

- <https://www.w3.org/TR/xmlschema-2/#regexs>

## Suppressing

Add a suppression with a reason for `IDSL-REGEX-001` (or `IDSL-REGEX-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
