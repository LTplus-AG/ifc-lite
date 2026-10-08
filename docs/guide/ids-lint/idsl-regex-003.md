<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-REGEX-003: Construct not supported by XSD regex

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

XSD regex has no lookarounds, non-capturing or named groups, backreferences, word boundaries (\b), lazy quantifiers or escapes of ordinary characters. A checker that implements XSD regex strictly rejects such a pattern or reads it differently. Non-capturing groups and escaped punctuation (\/) are read the same way by the common reference tools and appear in buildingSMART pass- test cases, so those findings are info only. Note that \d and \w are Unicode classes in XSD and \w excludes the underscore.

## Example

```xml
<xs:pattern value="(?:EI|REI)[0-9]+"/>
```

## Quick fix

Rewrite (?:…) as (…) and drop lazy markers (an anchored full match is the same either way); other constructs need a manual rewrite. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## References

- <https://www.w3.org/TR/xmlschema-2/#regexs>

## Suppressing

Add a suppression with a reason for `IDSL-REGEX-003` (or `IDSL-REGEX-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)
