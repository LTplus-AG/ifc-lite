// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU-instancing collation.
//!
//! Phase A produces baked meshes that carry [`InstanceMeta`] (rep-identity +
//! the per-occurrence world transform, split into placement `transform` and
//! optional mapping `local_transform`). This module groups occurrences that
//! share a representation into a single *template* geometry plus a list of
//! per-instance transforms, so the renderer can upload each unique mesh once
//! and `drawIndexed(.., instanceCount)`.
//!
//! ## Correctness contract
//!
//! All occurrences of one `rep_identity` are produced from the *same* cached
//! source-coords geometry (the `mapped_item_cache` returns clones of one mesh),
//! so their canonical geometry is bit-identical. The baked world vertices of
//! occurrence *k* are therefore `M_k · canonical`, where
//! `M_k = transform_k · local_transform_k`. Taking occurrence 0 as the template,
//! the per-instance transform that maps the template's baked world geometry onto
//! occurrence *k* is `rel_k = M_k · M_0⁻¹` (so `rel_0 = I`). This is exact up to
//! floating point; [`verify_recomposition`] bounds the residual and the unit
//! tests assert it stays within a micrometre.
//!
//! A shard carries ONE positions pool, ONE normals pool and ONE index pool per
//! template, so whatever the template holds is what every occurrence of its
//! group receives. For a DIRECT solid the key is `compute_mesh_hash_full`, which
//! has no equality guard behind it, so every per-vertex buffer the shard ships
//! has to be IN that key: 128 bits bound collisions among the fields hashed and
//! nothing else, and a buffer left out is not a rare collision but a certain one
//! on every pair that differs only there. `normals` were left out, on the premise
//! that they follow from `positions`; they do not, and the pair that proves it
//! lost its normals to whichever member became the template (#8287). (A MAPPED
//! occurrence's `rep_identity` is a RepresentationMap id, not that hash, and is
//! safe for a different reason: every occurrence is a clone of one cached source
//! mesh, so their pre-bake buffers are identical by construction.)
//!
//! #3716 established "verify, don't just re-key" for this key, and #8287 is the
//! exception that proves the rule rather than a departure from it. There, two
//! unrelated items COLLIDED: widening the hash would only have lowered the odds,
//! while verification proves absence for the group in front of it. Here nothing
//! collided. The key never read the field the two items differ in, so they are
//! not an unlucky pair but every such pair, and reading the field is what fixes
//! it. Verification cannot substitute, because the only normals the guard can see
//! are BAKED: the baker runs the inverse-transpose of each occurrence's placement
//! over them (`router::transforms::mesh_world`), so a group spanning two
//! rotations has different baked normals by design and the renderer is right to
//! rotate the template's pool by `rel`. A bitwise compare there would refuse that
//! correct group, which
//! `a_rotated_group_has_different_baked_normals_and_still_collates` runs and
//! shows, and a tolerant compare would not separate #8287's pair at all, since
//! the two openings share an `ObjectPlacement` and differ by ~1e-15. Hashing the
//! normals while they are still LOCAL splits the pair into two correct templates
//! instead of rejecting one group.
//!
//! What stays open, and is #3716's point: a genuine 128-bit collision between two
//! same-shaped items whose normals differ still passes `verify_pairing`, because
//! that check is positions-only and has to be. The key makes that the only
//! remaining way, at content-addressing odds, rather than a certainty.
//!
//! `rep_identity` (a 128-bit geometry hash for direct items) is not proven
//! collision-free, and a merged multi-model file has measured one (#3666):
//! two unrelated occurrences shared a hash and one reconstructed up to 2m
//! away from where it actually was, with nothing erroring. `collate_refs`
//! therefore does not just trust the identity for the exact tier: it
//! reconstructs each candidate occurrence from `(template, rel)` and
//! verifies it against that occurrence's own baked vertices before trusting
//! the group, falling the WHOLE group back to the flat path on any failure
//! (a mis-grouped occurrence means the template pairing is in doubt, not
//! just the one member that happened to fail first). The one exception is a
//! #1623 don't-bake placeholder: it has no geometry of its own, so flat is not
//! a place it can go — it stays instanced against the template (with the
//! template itself) rather than disappearing from the output entirely.
//!
//! ## Instanced wire format ("IFNS")
//!
//! Little-endian, mirroring the packed-shard conventions (header + tables +
//! pooled data) but carrying UNIQUE template geometry once + a per-occurrence
//! instance table, so the renderer uploads each template once and
//! `drawIndexed(.., instanceCount)`. This Rust encoder/decoder is the spec the TS
//! decoder mirrors. Flat (non-instanced) meshes are emitted as singleton
//! templates (one identity instance) so every input mesh is represented uniformly.
//!
//! Layout:
//!   Header (8 u32): magic, version, templateCount, instanceCount,
//!                   positionsLen, normalsLen, indicesLen, instanceStrideBytes
//!   Template table (templateCount × 48 bytes): posOff,posLen,nrmOff,nrmLen,
//!                   idxOff,idxLen (6× u32) then originX,originY,originZ (3× f64)
//!   Instance table (instanceCount × instanceStrideBytes): the 88-byte BASE
//!                   record — templateIndex(u32), entityId(u32), color(4× f32),
//!                   transform(16× f32, row-major rel_k) — followed by whatever
//!                   trailing fields the stride makes room for. Trailing field 1
//!                   is itemId(u32) at offset 88, so a shard carrying it declares
//!                   a stride of 92. Trailing field 2 (#5984, v3) is the
//!                   occurrence's IFC-authored finish, metallic(f32) +
//!                   roughness(f32) at offset 92, NaN where unauthored: stride
//!                   100, written only when some occurrence authors one.
//!   Data: positions (f32 × positionsLen), normals (f32 × normalsLen),
//!         indices (u32 × indicesLen). Offsets/lengths are ELEMENT counts; indices
//!         stay local to each template's vertex range (0-based).
//!
//! VERSIONING: APPEND-ONLY FIELDS AND A STRIDE THE READER READS.
//!
//! Per-instance fields are APPEND-ONLY, in a fixed canonical order. A field is
//! never removed and never reordered, so a record is always the 88-byte base
//! followed by trailing fields 1..n in that order. Header word 7 carries the
//! instance record STRIDE IN BYTES, which is what tells a reader how many of
//! those trailing fields the shard in front of it actually has: it decodes the
//! ones it knows and SKIPS the rest by stepping the stride.
//!
//! Word 7 was a literal `0` read by nobody in v1, and #2985 first spent it as a
//! FLAGS word. That was wrong. A decoder must REJECT a flag bit it does not know,
//! because an unknown bit changes the stride unknowably and a mis-strided read
//! yields plausible garbage rather than an error — so flags buy no forward
//! compatibility at all over the version word they duplicate. A stride the
//! decoder READS buys exactly that: a v3 shard that appends a field is still
//! readable by this v2 decoder, which finds every field it knows at its fixed
//! offset and steps over the tail it does not.
//!
//! So the version gate is PERMISSIVE where it can be:
//!   - version 1 (or word 7 == 0): stride 88, no trailing fields. A v1 producer
//!     other than this one could have put anything in a word documented as
//!     reserved, but it wrote `0`, and 0 is not a legal stride — both readings
//!     land on 88. That is what lets a v1 shard already persisted verbatim in a
//!     browser cache (`packages/cache/src/sections/instanced-shards.ts`) keep
//!     decoding, with `item_id: None`. This encoder also WRITES version 1
//!     whenever the derived stride is the base record, so such a shard is
//!     byte-identical to a pre-#2985 one and an older build can still read it.
//!   - any version >= 2 whose stride is READABLE and VALID (>= the 88-byte base,
//!     4-byte aligned, and small enough that the instance table it implies fits
//!     the buffer): decode the trailing fields this build knows, ignore the
//!     rest. Alignment is refused in both languages because every field is 4
//!     bytes and the TS decoder's pooled data views cannot even be constructed
//!     at an unaligned data offset.
//!
//! Version 0 is refused — it is not a version.
//!
//! Reading permissively does not make the cache key safe the other way round: a
//! bundle from before #2985 refuses every version but 1, so `@ifc-lite/cache`'s
//! FORMAT_VERSION moves 15 -> 16 with this change and an old bundle can no
//! longer match a key whose stored shards are v2.
//!
//! [`InstanceMeta`]: crate::mesh::InstanceMeta

mod collate;
mod dont_bake;
mod group;
mod verify;
mod wire;
mod wire_decode;

#[cfg(test)]
mod tests;

pub use collate::{
    bake_source_at_world, collate_instances, compose_instance_world_row_major,
    instance_rel_row_major_f32, verify_recomposition, Collated, InstanceMeshRef,
    InstanceOccurrence, InstanceTemplate,
};
pub use group::{collate_refs, collate_refs_in_basis, collate_refs_verified_in};
pub use wire::{
    collate_and_encode, encode_instanced, encode_refs, encode_refs_with_finishes, DecodedInstance,
    DecodedInstanced, DecodedTemplate, INSTANCED_MAGIC, INSTANCED_VERSION,
};
pub use wire_decode::{decode_instance_finishes, decode_instanced};
