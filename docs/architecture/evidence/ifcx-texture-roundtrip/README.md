# IFCX textured export/reopen qualification (#4325)

A fresh owner opened the fixed, previously authored Convento IFCZIP through the
normal file picker, created a new disposable signed room, and a fresh guest
joined. Both first contexts closed; another fresh context rejoined and picked a
textured object in the viewport. File → Export IFC exported the room as IFCX.
A fresh non-room context reopened that downloaded file through the normal file
picker and successfully picked its textured geometry.

The normal viewer reopened **115 textured mesh fragments, 120,835 triangles,
and 20 distinct IFC owner paths**. Fragment multisets keyed by canonical owner,
triangle/index buffer, UV buffer and decoded image match exactly. All image
buffers are the expected 1024×1024 RGBA with FNV-1a `f98e6d8d`.
See [the rendered model](reopened.png), [viewport picking](reopened-picked.png),
and [machine-readable measurements](fidelity.json).

Local position hashes are deliberately not presented as byte identity: the
existing IFCX export path bakes per-mesh origins into world coordinates. Each
fragment's f32 world-position hash matches after that conversion. An independent
fresh load of the same fixed source archive compared all 1,077,621 world-coordinate
components with the exported/reopened file: maximum error **1.9073486328125e-6 m**,
RMS **3.060902389330056e-7 m**, at maximum absolute coordinate 41.131011962890625 m.
Each component satisfies the scale-aware conservative f32 bound
`max(2^-149, abs(sourceWorldComponent) * 2^-23)`; the largest such bound is
4.903198714600876e-6 m. Pairing uses owner + triangle/index + UV/image association;
all 115 keys are unique, rather than matching unrelated nearest vertices.

The downloaded IFCX is **81,784,152 bytes**. This is an uncompressed JSON transport
with UV arrays and one deduplicated RGBA image, not a compression or zero-overhead
claim. Optional original PNG/JPEG source retention is independently covered by
the codec roundtrip test; the room transport supplies decoded pixels, so this
particular room has no original encoded channel to preserve.

The actual browser qualification used fix commits `b0700f254` and `9db1a2b7c` on main `215034294`,
plus the explicit existing #4211 browser prerequisites cherry-picked as
`255952cf5` and `3d196060a` (upstream `4e1425595` / `9cb3a356f`). Those prerequisite
commits are not part of this fix PR. The runtime was built from unchanged Rust
sources; SHA-256 `25cfce23a8ad684912ab36bc865e23b3bf4320f498bf833d50a9c07d66c2afc5`.
The final browser repeat includes the layered-path follow-up as `6cf35dce0`;
its world-f32 fingerprints match the coordinate measurement run.

A local reference relay used the real signed HTTP/WebSocket/blob flow. Every
participant ran in an independent Chromium context with WebGPU, and no rendering
or transport bypass was used. Room credentials and raw logs are intentionally
excluded from these artifacts. No existing user invite was used.

Fixed source archive SHA-256: `3cf62d211a8f953d306f9f35e2bad115620af34cde5ad12a080208e2eca1de8b`.
