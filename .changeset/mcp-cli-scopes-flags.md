---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": minor
---

Fix the MCP server's command line and read-only mode ([#11534](https://github.com/LTplus-AG/ifc-lite/issues/11534)).

- `model_load` and `model_unload` need `read` scope instead of `mutate`, so `--read-only` servers and read-only tokens can open models. `--allow` still bounds which files. `model_load` refuses an id outside the token's model allowlist.
- `ifc-lite-mcp --transport http` honours `--allow`. File arguments over HTTP still load nothing (each HTTP session starts empty and loads models with `model_load`), but both entry points now say so on stderr instead of ignoring them silently.
- `--token` is repeatable as documented, and the new repeatable `--read-only-token` registers tokens that can read and validate but not edit or export (exports write files on the host). A token cannot use another token's session. A value flag with no value (`--token --read-only`) is a usage error instead of swallowing the next flag.
- An HTTP server with no token no longer gives every caller `admin` scope. Anonymous callers get `read`, `validate`, `mutate` and `export` (read scopes only under `--read-only`); `admin` needs a `--token`. stdio is unchanged.
- Unknown flags print a warning on stderr. `--federate`, which never did anything, now warns too.
- `ifc-lite mcp` runs the same code as `ifc-lite-mcp` through the new `@ifc-lite/mcp/cli-main` subpath (`runMcpCli`, `mcpHelpText`), so it gains the bridge flags, `--allow-origin` and the new token flags. With no files it starts an empty session instead of exiting.
- `--help` prints the Claude Desktop config path for the current OS.
- `model_unload` is marked `destructiveHint`, and checks the model allowlist before saying whether a model is loaded.
- `CliOptions` replaces `token` with `tokens` and `readOnlyTokens`, drops `federate` and `bridgeMissingOperand` (a missing bridge value is now in `errors`), and adds `warnings` and `errors`; `bridge` is now required. `MCP_SUBCOMMAND_UNSUPPORTED_FLAGS` and `isMcpValueFlag` are removed. `--port` and `--viewer-port` must be integers from 0 to 65535.
- The Claude Code plugin runs `@ifc-lite/mcp@0` instead of whatever npm has, so a 1.0 cannot change it underneath. Releases before 0.32.0 ignore `--channel`.
- `--flag=value` works for every value flag. An unknown `--flag=value` is reported by its name only, and a value on a boolean flag (`--read-only=true`) is a usage error.
- Files with the same name passed together (`arch/model.ifc struct/model.ifc`) load as `model` and `model_2`; before, the second replaced the first.
- With `--allow`, files passed on the command line go through the same path policy as `model_load`: real paths, either spelling of a root, and protected home entries. A symlink inside an allowed directory that points outside it is refused. A preload that fails names the argument by position and a reason, such as an errno code (`ENOENT`, `EACCES`, `EISDIR`...), `outside --allow`, `protected home path` or `not a readable IFC file`, never the path.
