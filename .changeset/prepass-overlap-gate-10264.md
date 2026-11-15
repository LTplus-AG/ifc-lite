---
"@ifc-lite/geometry": patch
---

Large IFC files (512 MiB and up) loaded with a single geometry worker no longer have their memory peak before geometry inflated by the pre-pass overlapping that worker (#10264). On those loads the geometry worker receives its setup and first jobs only after the pre-pass has finished and its worker has been terminated, so the pre-pass heap no longer coexists with the worker's source copy and entity index (about 1.4 GB lower on a 1.2 GB entity-heavy file). Geometry output is unchanged. Loads planned with two or more geometry workers, and all smaller files, keep the current path. Worker-count plans are unchanged.
