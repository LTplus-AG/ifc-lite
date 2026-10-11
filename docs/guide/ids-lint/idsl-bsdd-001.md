<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-BSDD-001: bSDD URI not found or inactive

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The facet points at a bSDD class or property that bSDD does not know (any more), or that its owner has deprecated. Tools that follow the URI find nothing or an outdated definition, and the classification or property the requirement asks for may no longer be maintained. URIs are checked in the background (rate-limited, cached for 24 hours); an unchecked URI is not reported.

## Example

```xml
<classification uri="https://identifier.buildingsmart.org/uri/…/class/OLD-CODE" cardinality="required"> … </classification>
```

## Quick fix

Point the facet at the replacement bSDD publishes (and, for a classification, its code). Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-BSDD-001` (or `IDSL-BSDD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
