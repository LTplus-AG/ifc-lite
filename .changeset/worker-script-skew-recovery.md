---
"@ifc-lite/geometry": patch
"@ifc-lite/parser": patch
---

Harden huge-file loads against stale deployments and the wasm32 ceiling. (1) A geometry or pre-pass worker whose SCRIPT fails to load (a redeploy rotated the hashed asset; the 404 is served as text/plain and the browser blocks the worker with an empty-message onerror) now dispatches the existing version-skew recovery event so the viewer reloads once onto the current deployment, instead of dying with "Pre-pass worker failed: undefined". (2) The parser skips the byte-level WASM entity scan for sources over 2.5GB: the buffer copy plus entity index cannot fit in wasm32's 4GB address space, so the scan always trapped with `unreachable executed` before the JS tokeniser fallback ran anyway.
