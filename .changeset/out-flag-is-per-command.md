---
"@ifc-lite/cli": patch
---

`--out` is documented where it works, and refused where it does not. It was listed under the global `Options:` block as "Write output to file instead of stdout", but 21 of the 37 commands parse no such flag — so `ifc-lite info model.ifc --json --out info.json` wrote to stdout, created no file, and exited 0. The same was true of `query`, `stats`, `validate`, `props`, `schema`, `diff`, `ask`, `schedule`, `clash` and `ids`. It is now removed from the global list (the 16 commands that do take it already show `--out F` on their own line), and passing it to a command that cannot use it fails with a message naming the redirect to use instead and which commands do accept it.
