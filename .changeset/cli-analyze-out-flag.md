---
'@ifc-lite/cli': patch
---

Fix `ifc-lite analyze --out` being a silent no-op.

`analyzeCommand` excluded `--out <file>`'s value from its positional-argument
scan (so the path wasn't mistaken for the input IFC file) but never actually
wrote to it: results only ever went to stdout when `--json` was passed, or to
a stderr summary otherwise. A user running
`ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --out results.json`
got no error and no file — the flag looked accepted but did nothing.

`--out` now writes the match results as JSON to the given file, matching the
convention every other file-producing command in the CLI already follows
(`writeOutput`). Documented in `docs/guide/cli.md`'s `analyze` flag table.
