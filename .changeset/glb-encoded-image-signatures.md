---
"@ifc-lite/cache": patch
---

Reject embedded GLB images whose PNG/JPEG signature disagrees with their declared MIME type, preventing transparent PNG data from bypassing JPEG opacity handling.
