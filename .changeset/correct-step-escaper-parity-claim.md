---
'@ifc-lite/wasm': patch
---

Correction to the `6.0.0` entry for [#2987](https://github.com/LTplus-AG/ifc-lite/pull/2987). That entry ends:

> `ifc_lite_core::encode_ifc_string` already implemented the correct directive encoding. This change reimplements that encoding inline in the writer rather than calling it, so the two now agree but remain separate code paths.

That is false. `ifc_lite_export::step_text::escape` and `ifc_lite_core::encode_ifc_string` disagree on every input below U+0100 — the exact population #2987 was about — and only agree above U+00FF, where both take the same `\X2\`/`\X4\` directive form. Measured on current `main` (`rust/export/src/step_text.rs::escape` vs `rust/core/src/step_encoding.rs::encode_ifc_string`):

| input | `step_text::escape` | `encode_ifc_string` |
|---|---|---|
| `'` (U+0027) | `''` (doubled) | `'` (unchanged) |
| TAB (U+0009) | ` ` (one space) | `\X\09` |
| `\` (U+005C) | `\\` (doubled) | `\X\5C` |
| `Ä` (U+00C4) | `\X2\00C4\X0\` | `\X\C4` |

`encode_ifc_string` also never doubles the apostrophe, so its output is not safe to embed as a STEP string literal body.

This corrects the documentation only. The two encoders still disagree; nothing about their behaviour has changed here. See [#3300](https://github.com/LTplus-AG/ifc-lite/issues/3300).
