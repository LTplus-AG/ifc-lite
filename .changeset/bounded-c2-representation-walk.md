---
"@ifc-lite/wasm": major
---

Rust-only: require explicit representation expansion budgets and refusal handling, and share bounded product-root admission across geometry and profile extraction. `NestedMaps::Expand`, `WalkRefusal`, and `WalkVisitor::refused` change their public Rust contracts; consumers must provide a work allowance and handle detailed refusals. Record the newly published-baseline break as Rust break #15. JavaScript/WASM bindings are unchanged.
