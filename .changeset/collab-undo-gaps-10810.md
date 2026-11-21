---
"@ifc-lite/mutations": patch
"@ifc-lite/mcp": patch
"@ifc-lite/viewer": patch
---

A `DELETE_PROPERTY` mutation records the deleted row's `valueType` and `dataType`, so undoing the delete restores the property with its type, not as text, in the viewer and in the MCP server's undo. In a collab room, undo and redo now reach peers in the cases they missed: an edit to an unset attribute (inspector, reviewed changes, `bim.mutate.setAttribute`) and a move. Redoing an edit that cleared an attribute clears it again instead of writing the text `null`.
