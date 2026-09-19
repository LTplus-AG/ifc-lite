---
"@ifc-lite/diff": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/parser": patch
"@ifc-lite/viewer": patch
---

`lineageOfDiff` now classifies an identity-map alias whose reason carries the `successor:` prefix as `replaced`, instead of always `identity`, while `--lineage-in` preserves the incoming artifact's explicit relation even when its free-form reason suggests otherwise (issue #4989). This fixes replay without rewriting valid version-1 lineage semantics. Keyed lineage sidecars now use version 2, matching keyed identity maps, so old readers refuse authored keys instead of mistaking them for GlobalIds. The CLI also persists case-insensitive `--key-from tag` as canonical `Tag`, keeping its sidecars compatible with the viewer. CLI and MCP comparisons now fall back on both revisions when an authored key collides on either side, and shared `Pset.Property` identity lookup searches every same-named property set.
