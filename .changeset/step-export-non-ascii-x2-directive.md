---
"@ifc-lite/export": patch
"@ifc-lite/data": patch
---

Fix the STEP/IFC exporter writing non-ASCII characters (accented Latin, Cyrillic, CJK, emoji, etc.) as raw UTF-8 bytes instead of ISO 10303-21 `\X2\`/`\X4\` control directives.

ISO 10303-21 6.3.3.4 restricts a string literal's plain-text bytes to the basic graphic range 32-126; every other character must be a control directive, never a raw byte. A consumer that treats the file's bytes as ISO-8859-1 — the byte encoding the base standard and most real-world IFC tooling assumes for IFC2X3/IFC4/IFC4X3 — turned any name, label, or description carrying a non-ASCII character into mojibake or a broken parse. `escapeStepString` (in both `@ifc-lite/export` and `@ifc-lite/data`, the two copies that back the STEP writer and the shared header/entity serializer) now encodes such characters as `\X2\HHHH\X0\` (BMP) or `\X4\HHHHHHHH\X0\` (non-BMP), matching what our own reader already decodes and what real IFC tools expect.
