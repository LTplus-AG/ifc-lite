---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": patch
---

Fix the MCP server's command line and read-only mode ([#11534](https://github.com/LTplus-AG/ifc-lite/issues/11534)).

- `model_load` and `model_unload` need `read` scope instead of `mutate`, so `--read-only` servers and read-only tokens can open models. `--allow` still bounds which files.
- `--transport http` loads the file arguments into every session and honours `--allow`. A file that cannot be read stops startup.
- `--token` is repeatable as documented, and the new repeatable `--read-only-token` registers read-scope tokens.
- Unknown flags print a warning on stderr. `--federate`, which never did anything, now warns too.
- `ifc-lite mcp` runs the same code as `ifc-lite-mcp` through the new `@ifc-lite/mcp/cli-main` subpath (`runMcpCli`, `mcpHelpText`), so it gains the bridge flags, `--allow-origin` and the new token flags. With no files it starts an empty session instead of exiting.
- `--help` prints the Claude Desktop config path for the current OS.
- `CliOptions` replaces `token` with `tokens` and `readOnlyTokens`, drops `federate`, and adds `warnings`. `MCP_SUBCOMMAND_UNSUPPORTED_FLAGS` is removed.
- The Claude Code plugin runs `@ifc-lite/mcp@^0.32.0`, the first release with `--channel`.
