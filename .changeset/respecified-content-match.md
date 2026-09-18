---
"@ifc-lite/diff": minor
"@ifc-lite/mcp": patch
"@ifc-lite/cli": patch
"@ifc-lite/viewer": patch
---

**diff**: content matching gains a geometry-only step (issue #4955) that pairs an element deleted and redrawn in the same place with the same shape whose data changed — the wall an authoring tool auto-renamed on redraw. Tier 1 only fires inside a (`ifcType`, `dataHash`) bucket, so a renamed redraw landed in a different bucket from its previous revision and read as an add plus a delete. The new step re-buckets the residue by (`ifcType`, world geometry hash) between tier 1 and tiers 2–3 and retires a 1:1 bucket whose bounding boxes agree as a new retiring kind, `respecified`, tier `geometry-only`, with `ContentMatch.changedComponents` naming the data slices that moved and `ContentMatch.geometryHash` carrying the shared hash. An N:N geometry bucket is reported as `ambiguous` and retires nothing. Ordering is load-bearing: run after the positional tier, a slightly moved same-data neighbour would be paired to the stranded element on weaker evidence. `identityMapFromContentMatches` mints `content-match:respecified`. Existing callers get byte-identical results wherever no such pair exists. The viewer Compare panel, the MCP `model_diff` listing order and the CLI `--by-content` hint know the new kind.
