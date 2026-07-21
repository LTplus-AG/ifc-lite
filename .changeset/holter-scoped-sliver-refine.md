---
'@ifc-lite/wasm': patch
---

Scope the prism void fast path's post-cut sliver refinement to the cut region.

The refinement exists to repair high-aspect corner slivers a cut emits at an opening rim (#1007), but it scanned the whole host — so on models whose walls are legitimately full of long-thin authored faces (thin steel), it also bisected geometry the cut never created, inflating triangle output and paying the full lockstep fixpoint on every analytic-cut host. Holter Tower geometry drops ~3430ms → ~3180ms in wasm with ~10k fewer output triangles; ISSUE_098 improves ~19% natively. Unscoped callers (the exact kernel) keep their byte-identical one-split-per-round behaviour.
