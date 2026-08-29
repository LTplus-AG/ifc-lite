---
'@ifc-lite/wasm': patch
---

Correction to the `6.0.0` entry for [#2987](https://github.com/LTplus-AG/ifc-lite/pull/2987). That entry ends:

> `ifc_lite_core::encode_ifc_string` already implemented the correct directive encoding. This change reimplements that encoding inline in the writer rather than calling it, so the two now agree but remain separate code paths.

That is false. `ifc_lite_export::step_text::escape` and `ifc_lite_core::encode_ifc_string` diverge on four character classes: the apostrophe, the reverse solidus, control characters (the C0 range plus DEL), and everything in U+0080..U+00FF. Only the last of those four is part of the non-ASCII population #2987 was about; the other three are ASCII, and the CJK and emoji that entry names agree exactly. They agree on the rest of printable ASCII, and everywhere above U+00FF, where both take the same `\X2\`/`\X4\` directive form. Measured on current `main` (`rust/export/src/step_text.rs::escape` vs `rust/core/src/step_encoding.rs::encode_ifc_string`):

| input | `step_text::escape` | `encode_ifc_string` |
|---|---|---|
| `'` (U+0027) | `''` (doubled) | `'` (unchanged) |
| TAB (U+0009) | ` ` (one space) | `\X\09` |
| `\` (U+005C) | `\\` (doubled) | `\X\5C` |
| `Ä` (U+00C4) | `\X2\00C4\X0\` | `\X\C4` |

Swept over U+0000..U+02FF, comparing the two functions on every single-character input:

| range | differ |
|---|---|
| printable ASCII U+0020..U+007E | 2 of 95 — exactly `'` (U+0027) and `\` (U+005C) |
| control characters U+0000..U+001F and DEL U+007F | 33 of 33 |
| U+0080..U+00FF | 128 of 128 |
| U+0100..U+02FF | 0 of 512 |

One branch accounts for the Latin-1 block: `encode_ifc_string` has an `else if cp <= 0xFF { \X\{cp:02X} }` arm that `escape` does not, so the whole supplement takes a different directive form.

`encode_ifc_string` also never doubles the apostrophe, so its output is not safe to embed as a STEP string literal body.

This corrects the documentation only. The two encoders still disagree; nothing about their behaviour has changed here. See [#3300](https://github.com/LTplus-AG/ifc-lite/issues/3300).
