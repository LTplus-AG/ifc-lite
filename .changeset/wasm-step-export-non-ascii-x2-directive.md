---
"@ifc-lite/wasm": patch
---

Fix the Rust STEP writer (`ifc-lite-export`'s `step_text::escape`, used by `export_step`/`merged.rs`) writing non-ASCII characters as raw UTF-8 bytes instead of ISO 10303-21 `\X2\`/`\X4\` control directives — the same defect and fix as the TS-side `@ifc-lite/export`/`@ifc-lite/data` change. `ifc_lite_core::encode_ifc_string` already implemented the correct directive encoding but was never wired into this writer; it now is.
