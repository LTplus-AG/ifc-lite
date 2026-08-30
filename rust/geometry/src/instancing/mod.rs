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
//!                   a stride of 92.
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
mod wire;

#[cfg(test)]
mod tests;

pub use collate::{
    bake_source_at_world, collate_instances, collate_refs, compose_instance_world_row_major,
    instance_rel_row_major_f32, verify_recomposition, Collated, InstanceMeshRef,
    InstanceOccurrence, InstanceTemplate,
};
pub use wire::{
    collate_and_encode, decode_instanced, encode_instanced, encode_refs, DecodedInstance,
    DecodedInstanced, DecodedTemplate, INSTANCED_MAGIC, INSTANCED_VERSION,
};
