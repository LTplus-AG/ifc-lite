---
"@ifc-lite/geometry": patch
---

`exportMerged` now doubles a literal reverse solidus (`\`) inside STEP string literals, matching the apostrophe doubling it already did. ISO 10303-21 requires both `'` and `\` to be doubled in a string literal; only the apostrophe was, so the FILE_SCHEMA label was written as an under-escaped, non-conformant literal whenever it contained a `\`. `exportMerged`'s `schema` parameter is the only header field the wasm binding exposes to JS callers — the underlying `MergedOptions` also lets `description` and `application` be overridden, but the wasm binding always passes their fixed, special-character-free defaults — so this only changes output for schema labels containing `'` or `\`. Strings with no `'` or `\` are emitted byte-identically, as before.
