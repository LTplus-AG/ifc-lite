<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-002: Restriction base incompatible with the data type

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The restriction's base type (declared, or inferred: xs:string for patterns and enumerations, xs:double for numeric bounds) does not match the XSD type behind the property's dataType, for example numeric bounds on an IFCLABEL or a pattern on an IFCBOOLEAN. Values are cast to the data type before comparison, so the restriction cannot behave as written. The audit reports the same mismatch (E_RESTRICTION_BASE_MISMATCH).

## Example

```xml
<property dataType="IFCLABEL">…<value><xs:restriction base="xs:double"><xs:minInclusive value="1"/></xs:restriction></value></property>
```

## Quick fix

Declare the data type's base on the restriction (offered only when every literal is valid under it). Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-VAL-002` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
