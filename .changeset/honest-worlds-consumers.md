---
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/collab-server": patch
---

Initialize the shared diff runtime internally before the content comparison and layer merge operations that call the synchronous Rust facade. Initialization failures propagate and subsequent requests can retry through the shared runtime. Users of this package need no new setup.
