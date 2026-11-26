---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": patch
---

Fix the MCP server's command line and read-only mode ([#11534](https://github.com/LTplus-AG/ifc-lite/issues/11534)).

- `model_load` and `model_unload` need `read` scope instead of `mutate`, so `--read-only` servers and read-only tokens can open models. `--allow` still bounds which files. `model_load` refuses an id outside the token's model allowlist, and replacing an already loaded model needs `mutate` scope on a writable server.
- `ifc-lite-mcp --transport http` honours `--allow`. Both entry points refuse file arguments over HTTP instead of ignoring them: each HTTP session starts empty and loads models with `model_load`.
- `--token` is repeatable as documented, and the new repeatable `--read-only-token` registers read-scope tokens.
- Unknown flags print a warning on stderr. `--federate`, which never did anything, now warns too.
- `ifc-lite mcp` runs the same code as `ifc-lite-mcp` through the new `@ifc-lite/mcp/cli-main` subpath (`runMcpCli`, `mcpHelpText`), so it gains the bridge flags, `--allow-origin` and the new token flags. With no files it starts an empty session instead of exiting.
- `--help` prints the Claude Desktop config path for the current OS.
- `CliOptions` replaces `token` with `tokens` and `readOnlyTokens`, drops `federate`, and adds `warnings`. `MCP_SUBCOMMAND_UNSUPPORTED_FLAGS` is removed.
- The Claude Code plugin runs `@ifc-lite/mcp@>=0.31.0 <1.0.0` instead of whatever npm has. Releases before 0.32.0 ignore `--channel`.
