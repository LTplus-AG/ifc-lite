<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-BSDD-003: Value outside the allowed values bSDD publishes

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The property requirement references a bSDD property with a list of allowed values, but its value (or enumeration) contains values that list does not have (neither as a code nor as a label). A model filled from bSDD can then never pass, or the IDS has drifted from the dictionary. Allowing fewer values than bSDD (a project narrowing) is fine and not reported.

## Example

```xml
<property uri="https://identifier.buildingsmart.org/uri/…/prop/FireRating"> … <value><simpleValue>EI 60</simpleValue></value></property>
```

## Quick fix

Keep the values bSDD allows, or take its full list. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-BSDD-003` (or `IDSL-BSDD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
