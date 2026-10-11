<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-DOC-001: Author is not an e-mail address, or date is not xs:date

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | document | yes |

The IDS 1.0 schema requires info/author to be an e-mail address and info/date to be an xs:date (YYYY-MM-DD). Schema-validating tools reject the file otherwise.

## Example

```xml
<info><author>Jane Doe</author><date>08.10.2026</date></info>
```

## Quick fix

Rewrite an unambiguous date as YYYY-MM-DD; remove an author that is not an e-mail address. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-DOC-001` (or `IDSL-DOC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
