---
'@ifc-lite/merge': minor
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

The layer-diff JSON is now one shared contract: `diffStackStates`/`diffLayerStacks` (`StackDiff` shape, deterministically ordered) live in `@ifc-lite/merge`, and the CLI `layer diff` command and the MCP `diff_layer` tool consume the identical implementation — the two previously separate copies had already drifted on ordering. A byte-exact contract test pins the wire shape the review UI will consume.
