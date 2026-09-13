---
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/viewer": minor
---

Added `bim.structural` — a read-only query surface over the structural analysis data `extractStructuralOnDemand` already parses (analysis models, members, connections, actions/reactions, load groups, result groups). `bim.structural.data()` returns the full extraction plus `loadsTruncated`; `analysisModels()`, `members()`, `connections()`, `activities()`, `loadGroups()` and `resultGroups()` are convenience accessors over the same collections. Every consumer of `data()` — the SDK namespace, the sandbox script bridge, and both headless backends (CLI, MCP) plus the viewer's local backend — forwards `loadsTruncated` unchanged rather than defaulting it away, so a caller reading an applied load's configuration can tell a genuinely small load tree from one a reader bound (nesting depth, node budget, or a cycle guard) cut short.

This is layer 3 of #4206's six-layer structural analysis stack (semantic extraction, the read model, this query surface). A properties-card / panel UI, geometry, and a write/round-trip serializer remain out of scope for this change.
