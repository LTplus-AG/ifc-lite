<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PDT-001: Predefined type not in the entity enumeration

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | yes |

The predefinedType is not a member of the entity's PredefinedType enumeration in this IFC version, and the enumeration has no USERDEFINED member, so no element can carry it. Predefined types are compared case-sensitively.

## Example

```xml
<entity><name><simpleValue>IFCSITE</simpleValue></name><predefinedType><simpleValue>FOO</simpleValue></predefinedType></entity>
```

## Quick fix

Replace it by the closest enumeration value. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PDT-001` (or `IDSL-PDT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
