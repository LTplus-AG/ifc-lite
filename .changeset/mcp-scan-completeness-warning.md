---
'@ifc-lite/mcp': patch
---

Report a model whose scan dropped or skipped records. `LoadedModel.scanWarnings` carries the parser's `scan:` diagnostics, `model_load` returns them in its text and structured result, and models preloaded on the stdio CLI warn on stderr. Before, the loader silenced them along with the parser's console output, so an agent queried a short model with no sign it was short. A tool that misses an entity in such a model (`ENTITY_NOT_FOUND`) now carries a hint that the entity may be one of the dropped records.
