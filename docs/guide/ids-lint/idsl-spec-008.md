<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-SPEC-008: Specification without description or instructions

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info (opt-in) | static | specification | no |

Modellers see the description and instructions when a check fails. Without them the failure report shows only facet text, which rarely tells a modeller what to change or why the requirement exists.

## Enabling

This rule is off by default. Enable it in the linter config, at its default severity or another one: `createLinter(ctx, { severity: { 'IDSL-SPEC-008': 'info' } })`. Naming it in `rules` also enables it.

## Example

```xml
<specification name="Doors" ifcVersion="IFC4"> (no description, no instructions)
```

## Suppressing

Add a suppression with a reason for `IDSL-SPEC-008` (or `IDSL-SPEC-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
