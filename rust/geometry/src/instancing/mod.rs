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
