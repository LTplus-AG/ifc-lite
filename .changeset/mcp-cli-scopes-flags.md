---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": minor
---

Fix the MCP server's command line and read-only mode ([#11534](https://github.com/LTplus-AG/ifc-lite/issues/11534)).

- `model_load` and `model_unload` need `read` scope instead of `mutate`, so `--read-only` servers and read-only tokens can open models. `--allow` still bounds which files. `model_load` refuses an id outside the token's model allowlist.
- `ifc-lite-mcp --transport http` honours `--allow`. Both entry points now refuse file arguments over HTTP (exit code 2) instead of ignoring them: each HTTP session starts empty and loads models with `model_load`. Drop the files from such configs.
- `--token` is repeatable as documented, and the new repeatable `--read-only-token` registers read-scope tokens. Each token is its own principal, so one cannot use another's session. A value flag with no value (`--token --read-only`) is a usage error instead of swallowing the next flag.
- Unknown flags print a warning on stderr. `--federate`, which never did anything, now warns too.
- `ifc-lite mcp` runs the same code as `ifc-lite-mcp` through the new `@ifc-lite/mcp/cli-main` subpath (`runMcpCli`, `mcpHelpText`), so it gains the bridge flags, `--allow-origin` and the new token flags. With no files it starts an empty session instead of exiting.
- `--help` prints the Claude Desktop config path for the current OS.
- `model_unload` is marked `destructiveHint`, and checks the model allowlist before saying whether a model is loaded.
- `CliOptions` replaces `token` with `tokens` and `readOnlyTokens`, drops `federate` and `bridgeMissingOperand` (a missing bridge value is now in `errors`), and adds `warnings` and `errors`. `MCP_SUBCOMMAND_UNSUPPORTED_FLAGS` is removed.
- The Claude Code plugin runs `@ifc-lite/mcp@>=0.31.0 <1.0.0` instead of whatever npm has. Releases before 0.32.0 ignore `--channel`.
