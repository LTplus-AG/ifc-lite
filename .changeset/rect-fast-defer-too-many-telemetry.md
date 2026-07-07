---
"@ifc-lite/geometry": patch
"@ifc-lite/server-client": patch
"@ifc-lite/cli": patch
---

Surface the rect-fast `deferTooManyOpenings` counter in the geometry diagnostics. The Rust `RectFastSummary` already emits it (the opening-count DoS cap, #1649); the `GeometryDiagnostics.rectFast` and server-client types now include it (optional, defaulted to 0 when absent so older payloads merge cleanly), `mergeGeometryDiagnostics` sums it, and the CLI geometry report renders it in the rect_fast defer breakdown.
