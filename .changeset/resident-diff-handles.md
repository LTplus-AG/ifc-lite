---
"@ifc-lite/diff": minor
---

Expose explicitly owned DiffModelHandle snapshots with prepareDiffModel, compare,
idempotent dispose and Symbol.dispose. Add stripPlacementGeometry for comparing
the same resident models across geometry capability options, preserving exact
JS-stripping output. Document diffModels as the per-call one-shot convenience.
