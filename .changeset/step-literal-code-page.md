---
"@ifc-lite/encoding": patch
---

`decodeStepStringLiteral` keeps a `\P` code page in force past an escaped backslash, as the Rust decoder does, so `\PB\A\\\S\!` decodes to `A\Ą` instead of `A\¡`.
