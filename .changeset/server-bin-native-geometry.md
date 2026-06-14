---
"@ifc-lite/server-bin": patch
---

Rebuild the prebuilt native server binary to ship the latest Rust geometry/processing changes.

`@ifc-lite/server-bin` downloads its per-platform native archive from a GitHub release tagged at its own version, and the release workflow skips rebuilding assets when that tag already exists. Bump the patch version so a fresh `v<server-bin>` release fires and the prebuilt binary carries the merged native-side geometry work — the per-element local frame, the deterministic CSG escalation budget (the #1109 95% hang fix), the f64 interval-lambda / cmp_along predicate filters, and the curved-wall watertightness guard.
