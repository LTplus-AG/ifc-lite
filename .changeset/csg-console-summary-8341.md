---
"@ifc-lite/wasm": patch
---

The browser console summary of CSG and opening diagnostics is now formatted from the same `GeometryDiagnostics` the geometry batch returns, so the console and the typed diagnostics can no longer disagree (#8341). The headline, opening classifier, `rect_fast`, refused-reference and dropped-item lines are unchanged. The others change:

- **Worst-failing hosts** lists up to 16 hosts (was 10), ordered by failure count and then by ascending product id, so the list is the same on every run. The header reads `Worst-failing hosts (N shown, by failures then id):`. Each host line no longer lists its openings' kinds.
- **Breakdown** prints `Reason=count, …` (count descending, ties by reason) instead of a Rust debug list.
- **By host type**, the per-type host and opening roll-up, is removed from the failure warning and from the `Opening pipeline: 0 CSG failures. N hosts with openings.` note.
- **Silent no-op** reports the diagnostics' `silentNoOps` count, which leaves out a host that also recorded a CSG failure, and no longer lists the hosts.

A batch with nothing to report still prints nothing. The returned diagnostics are unchanged.
