---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": minor
---

New `ifc-lite-mcp install --client <claude-code|claude-desktop|cursor|vscode>` (also `ifc-lite mcp install`). It adds the server to the client's config, merging into an existing file with a backup, or runs `claude mcp add` / `code --add-mcp`. `--dry-run` prints the JSON or command, `--scope project` targets the current directory. Both commands dispatch through the shared MCP CLI runtime.

Claude Code `--force` backs up and atomically updates the selected config file while preserving custom server settings such as `env`.

File-based updates create backups under the installer lock and recheck the config before replacement. The lock coordinates IFClite installers, and concurrent external edits can still race the final rename.
