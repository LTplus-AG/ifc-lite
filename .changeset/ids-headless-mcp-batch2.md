---
"@ifc-lite/mcp": minor
---

New MCP tool `ids_diff` compares two IDS revisions semantically. It returns added, removed and changed entries with XML paths and one plain-language line each; renamed specifications and edited requirements are paired, not reported as a removal plus an addition. `ids_preview`, `ids_infer`, `ids_coverage` and `ids_test` are declared with their final input schemas. They answer `UNSUPPORTED_OPERATION` until the IDS model loop and the test-suite runner ship.
