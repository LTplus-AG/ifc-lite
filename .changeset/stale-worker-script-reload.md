---
"@ifc-lite/viewer": patch
---

A geometry or pre-pass worker whose script never loads is now reported as a missing engine file (`wasm_engine_load`) instead of a geometry worker crash. The user sees "reload the page" instead of advice to close tabs because the model is too large, and the load no longer starts a lowest-detail retry that fails the same way. In production this happened to tabs left open past the host's Skew Protection max age. Load exceptions also carry `bundle_age_hours`, so stale-bundle failures can be told apart from fresh ones.
