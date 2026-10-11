<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-006: Overlapping specifications with conflicting requirements

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | document | no |

Two specifications select exactly the same elements (identical applicability and IFC versions) but require values with nothing in common for the same attribute or property. No element can pass both. This rule only compares identical applicabilities; partially overlapping ones need a model to decide (SPEC-004, model-aware).

## Example

```xml
Spec A: IfcDoor, FireRating = EI30. Spec B: IfcDoor, FireRating = EI60.
```

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-006` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
