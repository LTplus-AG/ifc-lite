---
'@ifc-lite/cli': patch
---

`ifc-lite schema` now describes the `bim` object that `ifc-lite run` and `ifc-lite eval` actually hand to scripts (#3763). It printed `@ifc-lite/sandbox`'s `NAMESPACE_SCHEMAS` verbatim, which describes the browser sandbox bridge: there `bim.query.properties(ref)`, `bim.query.entity(...)` and ~19 siblings really are methods. The CLI's `bim` is a raw `BimContext`, where `query()` starts a builder chain and those methods sit at the top level, so every `bim.query.X(...)` call copied out of the dump — the command's whole purpose is API discovery for LLM tools — threw `TypeError: bim.query.X is not a function` on first use.

The dump now carries a `bim` namespace holding the top-level `BimContext` methods (`bim.properties(ref)`, `bim.quantities(ref)`, `bim.storeys()`, …) and a `query` namespace holding the builder chain reached via `bim.query()` (`byType`, `where`, `limit`, `toArray`, `count`, …). Both method lists are reflected off `BimContext.prototype` and `QueryBuilder.prototype` rather than transcribed, on the reduced-fallback path too, so they cannot drift from the runtime; a new test walks the emitted dump and resolves every documented path on a live context.
