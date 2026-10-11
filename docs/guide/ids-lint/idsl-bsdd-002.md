<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-BSDD-002: Classification system differs from the bSDD dictionary name

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

IDS checks a classification by its system name and code. When the facet references a bSDD class, the system should be the name of the dictionary that publishes the class, as bSDD gives it; authoring tools that write classifications from bSDD use that name, so a different or missing system name may match nothing.

## Example

```xml
<classification uri="https://identifier.buildingsmart.org/uri/…/class/EW"><value><simpleValue>EW</simpleValue></value><system><simpleValue>My system</simpleValue></system></classification>
```

## Quick fix

Use the bSDD dictionary name as the system. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-BSDD-002` (or `IDSL-BSDD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
