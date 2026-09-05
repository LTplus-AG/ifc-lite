---
"@ifc-lite/cli": minor
---

Add `ifc-lite delivery <recipe.json> [--json] [--out F] [--html F]`: a repeatable, reviewable model-delivery check that runs structural validation (the same rules `ifc-lite validate` runs) and/or IDS validation (the same validator `ifc-lite ids` runs) against one or more models from a saved, versioned recipe file.

A recipe declares `models`, an optional `structural: true`, and an optional `ids` list of rule files, with every path resolved relative to the recipe file's own directory; a recipe that declares zero applicable checks is a fatal error. Every check reports `pass`, `fail`, or `error` (an unreadable model, an unreadable/unparsable IDS file, or an IDS document with zero specifications) — never folded into `pass`. The overall verdict is `pass` only when every declared check on every declared model passed, so an unreadable model or an empty ruleset can never read as a successful delivery. The consolidated report records each model's SHA-256 fingerprint (or load error), the tool version, and every check's underlying `validate`/`ids` evidence, as a flat array (never keyed by model/type/source), so two checks can never collide and overwrite one another in the output; running the same recipe twice against unchanged files produces byte-identical JSON. `--html <file>` additionally renders a standalone HTML report alongside the JSON.
