<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-005: Boolean literal in a form IDS does not accept

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

IDS compares boolean values in their XSD lexical form, lower-case "true" and "false". "TRUE", "True", "yes" or "ja" never match (buildingSMART corpus: attribute/ and property/invalid-booleans_must_be_specified_as_lowercase_strings).

## Example

```xml
<property dataType="IFCBOOLEAN">…<value><simpleValue>TRUE</simpleValue></value></property>
```

## Quick fix

Normalise to "true" / "false". Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Verified assumptions

- **A-04**: buildingSMART corpus: pass-booleans_must_be_specified_as_lowercase_strings (attribute 3_3, property 2_3) accept "false"; fail-…_1_3 shows "true" is a comparable literal; invalid-…_2_3 / _3_3 mark "FALSE" as not conforming. The numeric forms 1/0 are not covered by the corpus and are not flagged.

## Suppressing

Add a suppression with a reason for `IDSL-VAL-005` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
