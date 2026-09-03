---
'@ifc-lite/cli': patch
---

`query --group-by storey|material`, `query --unique storey|material`, `ask` (building name, largest storey, largest/smallest element), and `stats` (building name, storey list, material summary) chained their name candidates with `??`/`.filter(Boolean)`/`!name`, which only falls through on null/undefined (or, for `!name`/`Boolean`, only catches a plain empty string). A storey or material whose `Name` is present but blank (`IFCBUILDINGSTOREY('...','',...)`, `IFCMATERIAL('',$,$)`) or whitespace-only short-circuited the chain and was emitted verbatim — an empty-string JSON key from `--group-by`/`--unique` instead of `"(no storey)"`/`"(no material)"`, a blank bullet in `ask`'s `answer:` string, a whitespace-string row in `stats`' material summary. Every site now falls through blank/whitespace candidates to the next one, same shape as `firstNonBlank`/`isBlank` in `packages/mcp/src/material-naming.ts`; a genuine name is still returned unchanged.
