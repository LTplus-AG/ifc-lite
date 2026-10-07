---
"@ifc-lite/flow-nodes": minor
"@ifc-lite/extensions": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": patch
---

Flow AI nodes with reviewed pause/resume on every host (#6923).

- `@ifc-lite/flow-nodes`: new `@ifc-lite/flow-nodes/ai` entry with `ai.classify`, `ai.summarize` and `ai.extract`, which call the host's `FlowHost.ai` service, spend the run's root budget, validate every key, label, citation and span the model returns, report coverage, and pause the run for review.
- `@ifc-lite/extensions`: the capability catalogue lists `network.ai` (send graph data to the host's AI model provider, red).
- `@ifc-lite/cli`: `flow run --checkpoint`, `flow review --approve <digest> | --reject` and `flow resume`, with an OpenAI-compatible AI service configured by `IFC_LITE_AI_MODEL` / `IFC_LITE_AI_API_KEY` / `IFC_LITE_AI_BASE_URL` and a per-run budget (`--ai-max-requests`, `--ai-max-output-tokens`). A paused run exits 3.
- `@ifc-lite/mcp`: `describe_flow` / `run_flow` report AI nodes as unavailable on this host instead of as unknown types.
