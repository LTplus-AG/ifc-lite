---
"@ifc-lite/geometry": patch
---

Large IFC files (512 MiB and up) loaded with a single geometry worker now have a much lower memory peak before geometry (#10264). On those loads the geometry worker receives its setup and first jobs only after the pre-pass has finished and its worker has been terminated, which removes most of the overlap between the pre-pass heap and the worker's source copy and entity index. The pre-pass worker's heap is released asynchronously after `terminate()`, so a small overlap can remain. Measured on a 1.2 GB entity-heavy file with one worker, the peak before geometry went from about 6.9 GB to about 5.3–5.5 GB (three runs each side). Geometry output is unchanged. Loads planned with two or more geometry workers, and all smaller files, keep the current path. Worker-count plans are unchanged.
