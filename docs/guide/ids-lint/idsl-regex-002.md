<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-REGEX-002: Pattern that is a plain value or matches everything

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

A pattern without any regex construct ("FireRating") is the same as a simple value, which is easier to read, translate and check. A value pattern of ".*" accepts every value, so it adds nothing to an existence check. (A ".*" around other text is meaningful in XSD, "contains", and is not flagged.)

## Example

```xml
<value><xs:restriction base="xs:string"><xs:pattern value="EI60"/></xs:restriction></value>
```

## Quick fix

Replace by a simple value, or drop the value so only existence is checked. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-REGEX-002` (or `IDSL-REGEX-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
