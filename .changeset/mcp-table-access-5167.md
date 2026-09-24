---
"@ifc-lite/mcp": minor
---

`run_flow` now provides the model's entity table to flow graphs, so `table.joinByKey`'s `tag` and `property` strategies run over MCP as they do in the viewer and `ifc-lite flow run`. `HeadlessLikeBackend.getOrCreateMutationView()` is public: it is the view `bim.mutate` writes through, and a join must read the same overlay.
