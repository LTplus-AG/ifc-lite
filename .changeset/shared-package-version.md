---
"@ifc-lite/mcp": patch
"@ifc-lite/data": minor
"@ifc-lite/cli": patch
---

The MCP server reports the version you can actually install. `VERSION` was the literal `'0.1.0'`, so `--version`, `--help` and the `serverInfo` block of every MCP `initialize` handshake announced 0.1.0 while the package was at 0.19.0 — in the one field a client UI puts in front of an operator.

The CLI had already paid for this exact mistake (a hard-coded `'0.4.0'` that `--version` still reported at 0.22.0) and fixed it with a `readCliVersion` helper. Rather than copy that helper into a second package, it moves to `@ifc-lite/data` as `readPackageVersion`, which both already depend on, so the two shipped servers cannot drift apart on how they answer `--version`. Its behaviour is unchanged: a broken install reports `0.0.0-unknown` on stderr rather than inventing a plausible number.
