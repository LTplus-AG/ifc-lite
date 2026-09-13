---
"@ifc-lite/data": patch
---

`escapeStepString` now encodes ASCII control characters (the C0 range and DEL) as `\X2\00HH\X0\` directives instead of one space each, so a newline in a header field or a serialized string value survives a write-and-read round trip. The record still stays on one line (no raw byte below 32 is written). Shared with the Rust `escape_step_string` through the cross-language vector file both are pinned to.
