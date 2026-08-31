---
'@ifc-lite/encoding': patch
---

Fix `decodeIfcString`'s `\S\` escape to honor the `\P?\` code page a STEP string literal selects, instead of always treating the result as ISO 8859-1 (ISO 10303-21 6.4.3).

`\S\C` decodes to the code point of `C` plus 128, then that 0x80..0xFF value is looked up in the code page most recently selected by a `\P?\` directive within the same string (default: ISO 8859-1, letter `A`). The decoder previously consumed and dropped every `\P?\` directive without tracking which page it selected, so `\S\` always added 128 to the operand's code point and used that as the Unicode code point directly — correct only for the default page, and silently wrong for any other one. `\PE\\S\P` (ISO 8859-5, Cyrillic) decoded to U+00D0 (LATIN CAPITAL LETTER ETH) instead of U+0430 (CYRILLIC SMALL LETTER A); every other non-default page (`\PB\`..`\PI\`, ISO 8859-2..9) was affected the same way. Old ArchiCAD/Allplan-era files using a non-default code page for `\S\` would decode incorrectly; the far more common `\X2\`/`\X4\` Unicode directives and files that never use `\P?\` were unaffected.

`decodeIfcString` now tracks the active code page across `\P?\` directives (letters `A`..`I` select ISO 8859-1..9; any other letter is dropped without changing the page) and maps `\S\`'s result through the matching table. A byte position the selected ISO 8859 part itself leaves unassigned falls back to the raw code point (the same answer the default page gives) rather than U+FFFD, since ISO 10303-21 does not define decoder behaviour there.

The equivalent Rust decoder (`ifc_lite_core::decode_ifc_string`, bundled into `@ifc-lite/wasm`) had the same bug and is fixed the same way; both are pinned to the same code-page test vectors in the shared `ifc_string_vectors.json` fixture so they cannot drift again.
