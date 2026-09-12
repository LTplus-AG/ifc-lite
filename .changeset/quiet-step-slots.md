---
"@ifc-lite/cli": patch
"@ifc-lite/export": patch
---

Refuse malformed STEP slot lists consistently before positional CLI mutations, export decisions, or schema conversion can rewrite the wrong attribute. Binary literals are now handled by the CLI validator, export record consumers share one validated slot reader, and Rust schema conversion preserves UTF-8 while leaving refused records transactionally unchanged.
