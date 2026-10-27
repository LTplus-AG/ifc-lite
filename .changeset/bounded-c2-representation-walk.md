---
"@ifc-lite/wasm": patch
---

Rust-only: require explicit representation expansion budgets and refusal handling, and share bounded product-root admission across geometry and profile extraction. `NestedMaps::Expand`, `WalkRefusal`, and `WalkVisitor::refused` change their public Rust contracts; consumers must provide a work allowance and handle detailed refusals. The Rust break is recorded as break #15 in `rust-major-offset.json` (Rust major 26); npm versions are unaffected. JavaScript/WASM bindings are unchanged.
