---
"@ifc-lite/viewer": patch
---

Compare panel: a "Key on" option keys the comparison on an authored `Tag` or `Pset.Property` instead of GlobalId, matching the CLI's `diff --key-from` and the MCP `model_diff` tool's `key_from`. Decisions (accepted suggestions, identity-map export/import) are scoped to the scheme they were made under, and a scheme mismatch on import is refused with the reason shown.
