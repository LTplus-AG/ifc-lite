---
"@ifc-lite/wasm": patch
---

Decode STEP string escapes (`\X2\`, `\X4\`, `\X\`, `\S\`, `\P\`) in the Rust parser so entity names and property values surface as native UTF-8, matching the TypeScript `decodeIfcString`. Previously the Rust/CLI/server path left the escapes literal (a name stored as `Name\X2\00FC\X0\` came through unescaped), while the browser parser decoded them, so the two paths disagreed on non-ASCII text. The Rust and TS decoders are now pinned to one shared test-vector fixture so they cannot drift.
