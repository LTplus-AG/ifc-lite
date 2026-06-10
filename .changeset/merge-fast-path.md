---
'@ifc-lite/merge': minor
---

Three-way planning meets the 05 §5.7 budget: a prefix projection fast path plans two 50k-op layers over a 1M-entity model in ~0.6s (was ~11.6s). When ours/theirs extend the ancestor stack, only suffix-touched paths are folded and hashed; untouched components share references and short-circuit on reference equality. Tombstone-bearing stacks keep the reference full extraction, with a differential fuzz suite enforcing equivalence between the two paths. Adds real-model partition fuzz (hello-wall + WekaHills fixtures) and `pnpm --filter @ifc-lite/merge bench`.
