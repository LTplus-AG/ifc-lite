---
"@ifc-lite/server-client": patch
---

Decoded Parquet geometry no longer gives every mesh its own three ArrayBuffers: a batch's positions, normals and indices are views into a few batch-sized buffers (at most 64 MiB each; a single array larger than that gets its own buffer). A 275k-mesh model decoded beside an already-loaded one spent most of its time in the browser's garbage collections that those allocations started.
