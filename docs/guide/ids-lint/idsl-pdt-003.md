<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PDT-003: Undeclared user-defined predefined type

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

The value is not in the PredefinedType enumeration, but the enumeration has USERDEFINED, so IDS matches it against the ObjectType (occurrences) or ElementType / ProcessType (types) of elements whose PredefinedType is USERDEFINED. That is valid (buildingSMART corpus: entity/pass-a_predefined_type_may_specify_a_user_defined_object_type), but it is also what a typo of an enumeration value looks like. Declaring it records that it is intentional.

## Example

```xml
<entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>PARAPETT</simpleValue></predefinedType></entity>
```

## Quick fix

Replace it by the closest enumeration value, or declare it as a user-defined type in the Studio sidecar. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PDT-003` (or `IDSL-PDT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
