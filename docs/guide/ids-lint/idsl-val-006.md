<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-006: Leading or trailing whitespace, or invisible characters

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

String comparison in IDS is exact. A value with a leading or trailing space, a non-breaking space or a zero-width character (typical of copy-paste from documents and spreadsheets) does not match the visually identical value in a model.

## Example

```xml
<simpleValue>EI60 </simpleValue>
```

## Quick fix

Trim the value and replace invisible characters. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-VAL-006` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
