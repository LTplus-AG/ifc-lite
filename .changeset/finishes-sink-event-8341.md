---
"@ifc-lite/server-bin": patch
"@ifc-lite/wasm": patch
---

The native pass can now report each mesh's IFC-authored finish itself (#8341). `ifc-lite-processing` adds `Features::finishes` (off by default) and `ProcessingSink::on_finishes`, which has a no-op default. With the feature on, `on_finishes` fires immediately before every `on_batch` with one entry per mesh, joined by the same rule `ModelFinishes` uses, from the pass's own scan and index. With the feature off, sinks and output are unchanged.

The server's JSON, Parquet, optimized-Parquet and streaming routes use the event, so they no longer scan each upload a second time to find finishes. Response bodies are unchanged.
