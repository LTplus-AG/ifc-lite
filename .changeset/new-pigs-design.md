---
"@ifc-lite/mcp": minor
---

Protect loaded model sources from file-writing tools, including filesystem aliases and source paths changed after loading. In-place writes now return PERMISSION_DENIED; export to a separate file instead.
