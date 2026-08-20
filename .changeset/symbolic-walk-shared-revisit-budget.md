---
'@ifc-lite/wasm': patch
---

`extract_symbolic_data` (`rust/processing/src/symbolic/mod.rs`) now shares
ONE `MAX_ITEM_REVISITS` revisit budget across every top-level representation
item in the extraction, instead of handing each top-level item its own fresh
budget. A file with N top-level items previously got N independent budgets,
so total memory was unbounded in the file's structure rather than its size:
measured, 300 annotations sharing one crafted 24-level mapped-item fan-out
cost 2.73 GB RSS from a 59 KB upload (release build). With the shared
budget, the same input measures ~13 MB RSS.

`path` and `seen` (the cycle guard and first-visit tracking) stay fresh per
top-level item — only the revisit counter is threaded across items. Sharing
those too would turn an ordinary `IfcMappedItem` reused by a second product
into a false revisit and truncate well-formed files that merely reuse
geometry, which is the failure #2938 exists to make observable rather than
trade for.

When the shared budget is exhausted partway through the file, a later
item's truncation is reported the same way #2938 already reports any other
truncation — a `tracing::warn!` with the product id, item id,
representation, and reason (`RevisitBudgetExhausted`, `MaxDepth`, or
`Cycle`) — so a hoisted-budget cutoff on a smaller legitimate drawing is
observable, not silent. `SymbolicData`'s shape and `extract_symbolic_data`'s
public signature are unchanged.
