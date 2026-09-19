---
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

`ifc-lite diff --by-content --geometry` runs the wasm mesh pass in Node (`setComputeGeometryHashes`, `geometryHashValues` / `geometryAabbValues` / `geometryVolumeValues`) and attaches world geometry hashes, bounding boxes and volumes to both files' fingerprints, promoting the comparison from `scope: 'data'` to `scope: 'both'` — so re-GUIDed elements are told apart by world geometry when their data alone is ambiguous, and moved/reshaped pairs are reported as such instead of a bare `renamed`. Skips gracefully with a stderr warning (pointing at `pnpm build:wasm:fetch`) when the wasm runtime is not built on the host, rather than failing the diff. New `--split-merge` / `--successors` flags opt into the two geometry-only detection stages, effective together with `--geometry`.

`model_diff`'s `by_content` mode gains matching `split_merge` / `successors` boolean params; this server has no geometry pipeline yet, so both currently produce no claims (the engine's abstention, not an error) — the plumbing is in place for when one lands (#4956).
