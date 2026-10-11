<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-008: Exact match on a real number

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | no |

The value is an exact real number on a floating-point data type. IDS 1.0 compares reals with a small relative tolerance (1e-6, see the buildingSMART tolerance test cases), which absorbs rounding but not unit conversion or modelling tolerance: 2.4 does not match 2.4004. A range states the tolerance explicitly. Tolerance handling is under discussion for IDS 1.1 (IDS issue #418).

## Example

```xml
<property dataType="IFCLENGTHMEASURE">…<value><simpleValue>2.4</simpleValue></value></property>
```

## References

- <https://github.com/buildingSMART/IDS/issues/418>

## Suppressing

Add a suppression with a reason for `IDSL-VAL-008` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
