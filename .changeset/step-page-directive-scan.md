---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": patch
---

Keep the apostrophe operand of a STEP `\S\` page directive inside its string during entity scanning. Legal page-encoded text no longer drops intervening records or produces an incorrect unterminated-string diagnostic. Preserve the Rust, TypeScript, and Blob-worker record boundaries together.
