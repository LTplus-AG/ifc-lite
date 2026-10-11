<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ENT-005: Entity name not in upper case

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

IDS 1.0 writes entity names in upper case (IFCWALL). Some checkers compare names case-insensitively and others reject mixed case (the buildingSMART corpus case entity/invalid-entities_must_be_specified_as_uppercase_strings), so a mixed-case name behaves differently across tools.

## Example

```xml
<entity><name><simpleValue>IfcWall</simpleValue></name></entity>
```

## Quick fix

Rewrite the name in upper case. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-ENT-005` (or `IDSL-ENT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
