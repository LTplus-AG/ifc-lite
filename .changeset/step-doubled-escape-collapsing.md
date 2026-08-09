---
"@ifc-lite/encoding": patch
---

`decodeIfcString` now collapses the doubled reverse solidus (`\\` → `\`), so a Windows path or a regex stored in an IFC string attribute reads back as its real value instead of with every separator doubled.

ISO 10303-21 doubles two characters inside a STEP string literal: the apostrophe (`''`) and the reverse solidus (`\\`). The apostrophe is un-doubled by this decoder's callers (they strip the surrounding quotes and un-double before decoding, which must happen in that order). The reverse solidus was collapsed by nobody at all — it fell into the "unknown escape, pass through" branch — so `C:\\temp` in a file surfaced as `C:\\temp` rather than `C:\temp`.

The pair is collapsed **after** the `\X2\` / `\X4\` / `\X\` / `\S\` / `\P..\` directive arms, not in a pre-pass. A directive immediately followed by an escaped backslash ends in three backslashes (`\X2\00FC\X0\` + `\\`); collapsing pairs left-to-right first would eat the directive's own terminator and leave an unterminated `\X2\`. Conversely a leading escaped backslash makes the text after it literal (`\\X2\00FC\X0\` is the characters `\X2\00FC\X0\`, not `ü`).

Strings with no escapes are unchanged, and `\X2\00E9\X0\` still decodes to `é`. The one behaviour change beyond the fix itself is on malformed input: `\X4\\X0\` (an empty, and therefore invalid, hex payload) now decodes to `\X4\X0\` rather than keeping both backslashes, because what is left after the invalid directive genuinely is a doubled reverse solidus.

The Rust decoder in `ifc-lite-core` gets the same arm, and the shared cross-language vector fixture gains cases for both escapes plus a new end-to-end set that pins the composed un-double-then-decode contract — the two decoders agreeing was not enough to catch this, since neither of them owns the `''` half.
