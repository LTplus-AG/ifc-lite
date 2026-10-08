---
"@ifc-lite/cli": minor
"@ifc-lite/ids-authoring": minor
---

`ifc-lite ids` gains three IDS authoring subcommands that need no model: `ids audit <rules.ids>` (IDS 1.0 conformance audit), `ids lint <rules.ids>` (the 43-rule IDSL catalogue, with `--rules`, `--severity CODE=level` and `--fail-on`) and `ids fmt <rules.ids>` (canonical formatting with `--check` and `--write`). All take `--json` where it applies and share one exit-code contract: 0 clean, 1 findings, 2 usage error, unreadable input, or a file this build cannot write without loss. `fmt` re-reads what it writes and refuses instead of dropping content.

`@ifc-lite/ids-authoring` adds the headless helpers behind them: `readStudioDocument` / `studioDocumentFromIds` (node ids derived from the content, so the same XML always gets the same ids), `parseStudioDocument` (validates a document that crossed a process boundary), `writeStudioDocument` / `writeIdsChecked` / `formatIds` (write through an injected `IdsWriter` and prove the XML reads back with every value) and `nodePath` (a node's XML path, e.g. `specifications[0].requirements[1].baseName`).
