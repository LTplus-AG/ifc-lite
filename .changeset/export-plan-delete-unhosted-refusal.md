---
"@ifc-lite/wasm": patch
---

Rust only, in `ifc-lite-export`; nothing in the wasm package changes. When an export plan preserves an opening or projection whose host it deletes, the refusal now says the object has no host left, instead of the generic "object is removed by this plan". A delete no longer collects referrer counts for objects and types it never prunes, and parses each record it touches once.
