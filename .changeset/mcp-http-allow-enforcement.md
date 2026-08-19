---
'@ifc-lite/cli': patch
---

Fix `ifc-lite mcp --allow` not being enforced under `--transport http`.

`--allow <dir>` is documented as restricting file-system access for both
transports, and it worked correctly under the default stdio transport: the
session config built there carried `allowedPaths`, which `resolveSafePath`
(`packages/mcp/src/safe-path.ts`) uses to bound every LLM-supplied path,
including the `load_model` tool's own file read.

Under `--transport http`, the per-session config built by `SessionFactory.build`
in `packages/cli/src/commands/mcp.ts` omitted `allowedPaths` entirely, even
when `--allow` was passed. With `allowedPaths` unset, `buildAllowedRoots`
falls back to its "sensible workspace" default: the directories of any
currently-loaded models, `process.cwd()`, and `os.tmpdir()` — not the whole
filesystem, but broader than what `--allow` was supposed to restrict access
to, and silently so. A user who verified `--allow` under stdio and then
switched to `--transport http` for the same restriction got no error and no
narrowing.

The http session config now includes `allowedPaths`, so `--allow` means the
same thing under both transports.
