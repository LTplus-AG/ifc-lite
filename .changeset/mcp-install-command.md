---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": minor
---

New `ifc-lite-mcp install --client <claude-code|claude-desktop|cursor|vscode>` (also `ifc-lite mcp install`). It adds the server to the client's config, merging into an existing file with a backup, or runs `claude mcp add` / `code --add-mcp`. `--dry-run` prints the JSON or command, `--scope project` targets the current directory. New `@ifc-lite/mcp/install` export.
