---
"@ifc-lite/cli": patch
---

`ifc-lite <command> --help` describes that command instead of printing the global help. `main()` answered `--help` before dispatch with the command still in `args`, so all 37 subcommands returned the same page — and the CLI's own docs tell LLM users to "discover all capabilities by running `ifc-lite --help`", with no second level to discover. It also made the real per-command help already written in `layer`, `ref` and `ext` unreachable: those handlers test for `--help` and were never reached. Those three now answer for themselves; every other command gets its entry from the `Commands:` block, continuation lines included, plus a link to the full reference. An unrecognised name still falls back to the global page.
