---
"@ifc-lite/merge": patch
---

Fix the three-way merge, layer diff, and revert-op paths trusting a `stableHash` component match with no fallback content check.

`snapshotOf` (`component-state.ts`) hashes each component's canonical JSON with `stableHash`, and every consumer — the three-way merge's fold/keep-ours decisions, the layer diff's changed-component detection, and revert-op generation — decided "same content" from hash equality alone. `stableHash` is a 64-bit FNV-1a hash: strong, but not cryptographic, and unlike `packages/diff`'s content-match pass (which requires an independent component sub-hash or geometry-hash agreement before trusting a `dataHash` match) nothing here had a fallback. A collision would have silently folded two genuinely different concurrent edits into one — the losing edit vanishes with no conflict raised — or silently skipped reverting a component that had actually changed.

`attributesContentEqual` now verifies with an exact canonical-JSON comparison whenever two hashes already agree, at negligible cost since it only runs on the (common) case of an actual match. No behavior changes for any non-colliding pair.
