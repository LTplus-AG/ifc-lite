---
"@ifc-lite/ai": minor
"@ifc-lite/flow": minor
"@ifc-lite/mcp": minor
"@ifc-lite/cli": patch
---

Enable explicitly configured AI Flow runs in MCP with durable pending artifacts and a separate digest-approved `resume_flow` call. Continuations recheck graph, native effective model state, current scope and the original root budget, then consume one disk CAS claim. Share the existing compatible provider transport and file checkpoint store with the CLI through separate package entries.
