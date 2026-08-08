---
"@ifc-lite/geometry": patch
---

`exportMerged` now doubles a literal reverse solidus (`\`) inside STEP string literals, matching the apostrophe doubling it already did. ISO 10303-21 requires both `'` and `\` to be doubled in a string literal; only the apostrophe was, so the FILE_SCHEMA label was written as an under-escaped, non-conformant literal whenever it contained a `\`. `exportMerged`'s `schema` parameter is the only header field exposed to callers of this API (the description and application fields are fixed internal defaults with no special characters), so this only changes output for schema labels containing `'` or `\`. Strings with no `'` or `\` are emitted byte-identically, as before.
