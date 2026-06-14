---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Fix curved / opening-dense wall hairline cracks (a watertightness guard on consolidation)

`ClippingProcessor::consolidate_coplanar` re-triangulates each coplanar plane
bucket of the exact-kernel cut output INDEPENDENTLY. On a curved/faceted or
opening-dense host, a FLAT bucket whose boundary runs along the faceted surface
(an opening reveal, a cap, a curved-wall rim) gets its boundary chorded by the
i_overlay union + collinear simplify — dropping the facet-boundary vertices the
abutting buckets keep. The result was open boundary edges + T-junctions at the
cut seam: thin white horizontal hairline cracks that shimmer under double-sided
rendering. The raw kernel output is watertight; only the post-kernel
consolidation introduced the gaps (a 24-facet curved host cut by one opening went
from 0 open edges raw to 9 after consolidation).

The fix is a watertightness guard at the end of `consolidate_coplanar`: if
consolidation INTRODUCED open boundary edges and the raw kernel mesh is the
cleaner one overall (by open edges + spike triangles), return the raw mesh. The
overwhelming majority of hosts consolidate watertight (count 0) and return
immediately — byte-identical, so the determinism snapshots and the
`indirect_sign_manifest` constant are unchanged (the exact kernel is untouched).
Only genuinely-torn hosts fall back to raw.

Result on ISSUE_068 (opening-dense school): curved-wall open boundary edges
4973 → 2323 (-53%), with the worst walls (the curved reception counter) now
watertight. Also fixes a latent cavity crack on the #780 bath and ~110 latent
open edges on the FZK-Haus gable walls (their `csg_quality` bar is updated from
spike-free to watertight, since the visible defect was the cracks). A future
seam-preserving consolidation should deliver both watertight AND sliver-free for
the residual "both-outputs-imperfect" hosts.
