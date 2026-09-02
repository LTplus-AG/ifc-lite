---
'@ifc-lite/mcp': minor
---

`quantity_diff`'s group-by-storey grouping chained `model.bim.storey(e.ref)?.name ?? '(none)'`, which only falls through on null/undefined. A storey whose `Name` is present but blank (`IFCBUILDINGSTOREY('...','',...)`) or whitespace-only short-circuited the chain and was used verbatim as the group key instead of falling through to `(none)`. Same defect family as #3515 / `materialFallbackName` (`material-naming.ts`).

Also exports `isBlank`/`firstNonBlank` from `@ifc-lite/mcp/browser` (the browser-safe entrypoint already re-exports the node-free kernel other in-browser MCP consumers need) so the web playground's dispatcher can reuse the same blank/whitespace-name handling instead of duplicating it.
