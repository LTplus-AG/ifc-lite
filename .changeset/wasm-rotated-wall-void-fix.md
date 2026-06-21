---
"@ifc-lite/wasm": patch
---

Bump the wasm package for the rotated-wall void-overcut fix (#1167). The fix is
Rust geometry code compiled into `@ifc-lite/wasm`, but its original changeset
bumped only `@ifc-lite/geometry` — so the package that actually carries the
compiled fix never got a release. This patch bumps `@ifc-lite/wasm` (and
cascade-patches `@ifc-lite/geometry`, which depends on it) so consumers pinning
the wasm package receive the corrected geometry. Also includes the #1259/#1270
review follow-ups: per-opening frame gating in the local-frame cut, faithful
per-cutter depth direction, and a both-bounds finiteness check.
