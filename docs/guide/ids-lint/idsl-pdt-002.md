<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PDT-002: USERDEFINED predefined type without an ObjectType requirement

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

An element with PredefinedType USERDEFINED is meant to say what it is in ObjectType (ElementType for types, ProcessType for process types). A specification that selects USERDEFINED elements without requiring that attribute accepts elements that never say what they are (IDS issues #178, #447).

## Example

```xml
<entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>USERDEFINED</simpleValue></predefinedType></entity>
```

## Quick fix

Add a requirement that the ObjectType (or ElementType / ProcessType) attribute is present. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## References

- <https://github.com/buildingSMART/IDS/issues/178>
- <https://github.com/buildingSMART/IDS/issues/447>

## Suppressing

Add a suppression with a reason for `IDSL-PDT-002` (or `IDSL-PDT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
