---
"@ifc-lite/clash": patch
---

Fix clash false positives and overstated contact regions (#1362, #1402). The coplanar-overlap fallback now confirms a real shared volume (point-in-solid probe) before reporting a hard clash, so skewed or abutting members that only touch at a face are no longer flagged. Hard verdicts now report a tight contact AABB (clamped to the element overlap) instead of the full whole-element AABB overlap. The focused-clash region box draws this tight contact region (on by default, marking the penetration; toggle in clash settings), replacing the former whole-element box. The TS reference engine and the Rust/WASM kernel stay byte-compatible.
