---
'@ifc-lite/wasm': patch
---

Fix `exportStep` silently discarding the caller's edits when `mutationsJson`
fails to parse.

`export_step_json` (`rust/export/src/step.rs`) fell back to
`serde_json::from_str(mutations_json).unwrap_or_default()`: a malformed or
version-mismatched `mutationsJson` payload became an empty `MutationsJson`
rather than an error, so the WASM binding returned a normal-looking, fully
re-parseable STEP file with none of the caller's attribute/property edits
applied. There was no way to tell that result apart from "the caller genuinely
passed no mutations" — the failure was indistinguishable from success.

`export_step_json` now returns `Result<String, String>` (BREAKING for the Rust
crate `ifc-lite-export`, its only caller is this crate's `exportStep` wasm
binding) and the wasm binding throws (`exportStep: <message>`) on a malformed
payload instead of swallowing it, matching `exportGlb`'s existing fail-closed
contract on this same API. An empty `mutationsJson` string is unaffected and
still exports with no mutations applied.

No change to `exportStep`'s JS signature or its behavior on valid input.
