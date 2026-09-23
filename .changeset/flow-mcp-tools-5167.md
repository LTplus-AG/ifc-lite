---
"@ifc-lite/flow": minor
"@ifc-lite/mcp": minor
---

Add `describe_flow` and `run_flow` MCP tools (#5167 Phase 4.3): agents can now discover and execute a `.flow.json` graph headlessly through MCP, exactly as `ifc-lite flow run` does. `describe_flow` returns a graph's declared inputs/outputs with types and registry-aware wiring diagnostics (`validateFlowWiring`, not just the registry-free `parseFlowDocument`) without throwing on an invalid graph. `run_flow` executes a graph against a loaded model, rejects `inputs` keys naming no declared parameter, and reports the run status plus a summary of tracked writes. `@ifc-lite/flow` gains `describeFlowIO`, `resolveDeclaredParam`, `unknownInputKeys`, and `declaredInputKeys` — the introspection/input-validation helpers now shared between `@ifc-lite/cli`'s `flow` command and the new MCP tools, so the two callers cannot independently drift on what counts as a declared parameter.
