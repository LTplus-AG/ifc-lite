<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PSET-002: Custom property set with a reserved prefix

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | yes |

The prefixes Pset_ and Qto_ are reserved for sets published by buildingSMART. A set with such a name that is not a standard set of the IFC version is either a typo of a standard name or a custom set that must use its own prefix. (Qto_ names cannot be verified for IFC2X3 and IFC4, whose tables have no quantity sets; they are not flagged.)

## Example

```xml
<propertySet><simpleValue>Pset_MyCompanyData</simpleValue></propertySet>
```

## Quick fix

Use the closest standard set, or rename it with a project prefix and declare it as a custom set. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PSET-002` (or `IDSL-PSET-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
