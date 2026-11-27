// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The partition and wire of the global instance plan (`global_plan.rs`).
//!
//! The batch materializes every mesh exactly as an unplanned batch does. The
//! partition then sends a mesh to the instanced shard when the PLAN names its
//! geometry (a planned mapped source, or a content-key planned element) and
//! the mesh itself can ride the instanced pipeline; everything else goes
//! flat. No per-batch tally is consulted, so the split depends on the file
//! only.
//!
//! Wire: an ordinary IFNS shard followed by a KEY TRAILER after the data
//! pools: `"IFNL"`, a u32 template count, then one u64 key per template
//! record as (hi, lo) u32 words. Every keyed record carries its geometry
//! (taken back to the template's local frame from the batch's first
//! occurrence), so a shard is self-contained: a consumer joins records with
//! equal keys of one model into ONE template and ignores the geometry of all
//! but the first. Each occurrence is verified against its own batch's
//! template; a joining consumer must check that a later record's template
//! matches the one it keeps (shape, local bounds) and draw a mismatch on its
//! own. A consumer that ignores the trailer draws one template per record,
//! which can be small, so arm the plan only with a joining consumer.
//! Meshes of a styled source reached through a nested map stay flat. Decoders that predate the trailer stop reading at the end
//! of the pools and see an ordinary shard.

use super::batch_output::{rtc, ElementMeshOutput};
use super::batch_partition::{is_instancing_candidate, tallyable_rep};
use super::batch_wire::BatchWire;
use super::global_key_plan as kp;
use super::global_plan::{GlobalPlan, SharedGlobalPlan};
use super::partitioned_batch::PartitionedBatch;
use super::style_finishes::{finish_at, mesh_js_with_finish};
use crate::zero_copy::MeshCollection;
use ifc_lite_geometry::{compose_instance_world_row_major, GeometryDiagnostics, Mesh};
use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;
use std::collections::hash_map::Entry;

/// Absolute floor of the keyed reconstruction check (0.1 mm): far below any
/// collision's misplacement, far above f32 recomposition noise.
const RECOMPOSE_FLOOR_M: f64 = 1e-4;

/// `"IFNL"` little-endian: the template-key trailer magic.
pub(super) const KEY_TRAILER_MAGIC: u32 = 0x4946_4E4C;

/// One planned occurrence: the template key, the element, its colour, its
/// pre-RTC world placement, item id and finish.
struct KeyedOccurrence {
    key: u64,
    entity_id: u32,
    color: [f32; 4],
    world: [f64; 16],
    item_id: Option<u32>,
    finish: Option<SpecularMaterial>,
}

/// The batch's keyed templates and occurrences.
#[derive(Default)]
struct KeyedBatch {
    templates: FxHashMap<u64, Mesh>,
    occurrences: Vec<KeyedOccurrence>,
}

impl KeyedBatch {
    /// Instance `mesh` against `key`, defining the key from it when this batch
    /// has no template for it yet. Every occurrence, the defining one
    /// included, must rebuild from the template within the reconstruction
    /// tolerance (`ifc_lite_geometry::recomposes`, the #3666 gate every
    /// collated group passes, floored at [`RECOMPOSE_FLOOR_M`]). A mesh that cannot (a singular placement, or
    /// geometry the key does not pin down) is handed back to go flat.
    fn push(&mut self, key: u64, mesh: MeshData, finish: Option<SpecularMaterial>, rtc: [f64; 3]) -> Option<MeshData> {
        let Some(meta) = mesh.instance.as_ref() else { return Some(mesh) };
        let world = compose_instance_world_row_major(meta);
        let (template, fresh) = match self.templates.entry(key) {
            Entry::Occupied(slot) => (slot.into_mut(), false),
            Entry::Vacant(slot) => match kp::to_local(&mesh, &world, rtc) {
                Some(local) => (slot.insert(local), true),
                None => return Some(mesh),
            },
        };
        let rel = kp::post_rtc(&world, rtc);
        if !ifc_lite_geometry::recomposes(template.origin, &template.positions, mesh.origin, &mesh.positions, &rel, RECOMPOSE_FLOOR_M) {
            if fresh {
                self.templates.remove(&key);
            }
            return Some(mesh);
        }
        self.occurrences.push(KeyedOccurrence {
            key,
            entity_id: mesh.express_id,
            color: mesh.color,
            world,
            item_id: mesh.geometry_item_id,
            finish,
        });
        None
    }
}

/// Can every mesh of a content-key planned element instance?
fn keyed_element(meshes: &[MeshData]) -> bool {
    (1..=kp::KEY_PLAN_MAX_SUBMESHES).contains(&meshes.len())
        && meshes.iter().all(|m| !m.positions.is_empty() && m.texture.is_none() && m.geometry_class == 0 && tallyable_rep(m).is_some())
}

/// The planned key of one mesh of an element that is not content-key planned.
fn mapped_key(plan: &GlobalPlan, mesh: &MeshData) -> Option<u64> {
    let rep = tallyable_rep(mesh)?;
    let source = plan.mapped_source(rep, mesh.geometry_item_id)?;
    // No sub-mesh index: where a source's mesh sits in its host element says
    // nothing about its geometry (eight balusters of one railing share it).
    Some(kp::template_key(source, rep, 0, mesh))
}

/// The partition under a global instance plan.
pub(super) fn partitioned_global(
    outputs: Vec<ElementMeshOutput>,
    csg_diag: GeometryDiagnostics,
    plan: &SharedGlobalPlan,
    wire: &BatchWire<'_>,
) -> PartitionedBatch {
    let plan = plan.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut collection = MeshCollection::with_capacity(wire.jobs_flat.len() / 3);
    if wire.needs_shift {
        collection.set_rtc_offset(wire.rtc_x, wire.rtc_y, wire.rtc_z);
    }
    let rtc = rtc(wire);
    let mut keyed = KeyedBatch::default();
    for out in outputs {
        if let Some(fp) = out.fingerprint() {
            collection.push_geometry_hash(fp);
        }
        let index = plan.keyed_jobs.get(&out.id).copied().filter(|_| keyed_element(&out.meshes));
        for (s, mesh) in out.meshes.into_iter().enumerate() {
            let finish = finish_at(&out.finishes, s);
            let key = if !is_instancing_candidate(&mesh) {
                None
            } else if let Some(index) = index {
                tallyable_rep(&mesh).map(|rep| kp::template_key(kp::content_key_hi(index), rep, s, &mesh))
            } else {
                mapped_key(&plan, &mesh)
            };
            let flat = match key {
                Some(key) => keyed.push(key, mesh, finish, rtc),
                None => Some(mesh),
            };
            if let Some(mesh) = flat {
                collection.add(mesh_js_with_finish(mesh, finish));
            }
        }
    }
    drop(plan);
    collection.set_diagnostics(csg_diag);
    let instanced_occurrences = keyed.occurrences.len();
    PartitionedBatch {
        meshes: Some(collection),
        shard: encode_keyed_batch(keyed, rtc),
        instanced_occurrences,
    }
}

/// The batch's keyed shard: templates by ascending key, each with its
/// occurrences by element, written by the IFNS encoder every shard uses, then
/// the key trailer. Empty when nothing instanced.
fn encode_keyed_batch(mut batch: KeyedBatch, rtc: [f64; 3]) -> Vec<u8> {
    if batch.occurrences.is_empty() {
        return Vec::new();
    }
    batch.occurrences.sort_by_key(|o| (o.key, o.entity_id));
    let mut keys: Vec<u64> = batch.templates.keys().copied().collect();
    keys.sort_unstable();
    encode_keyed_shard(&keys, &batch.templates, &batch.occurrences, rtc)
}

/// Encode `occurrences` (sorted by key) against the templates of `keys`
/// (ascending) as an IFNS shard plus the `IFNL` key trailer. Template records
/// come first in the encoder's mesh list, occurrences after; instance
/// transforms are the post-RTC world placement, as every IFNS reader expects.
fn encode_keyed_shard(keys: &[u64], templates: &FxHashMap<u64, Mesh>, occurrences: &[KeyedOccurrence], rtc: [f64; 3]) -> Vec<u8> {
    use ifc_lite_geometry::{Collated, InstanceMeshRef, InstanceOccurrence, InstanceTemplate};
    let mut refs: Vec<InstanceMeshRef<'_>> = keys
        .iter()
        .map(|k| {
            let m = &templates[k];
            InstanceMeshRef { positions: &m.positions, normals: &m.normals, indices: &m.indices, origin: m.origin, instance_meta: None, entity_id: 0, color: [0.0; 4], item_id: None }
        })
        .collect();
    let mut finishes: Vec<[f32; 2]> = vec![[f32::NAN; 2]; keys.len()];
    let mut collated = Collated::default();
    for (template_index, &key) in keys.iter().enumerate() {
        collated.templates.push(InstanceTemplate { rep_identity: key as u128, template_index, occurrences: Vec::new() });
    }
    let mut template = 0;
    for o in occurrences {
        while keys[template] != o.key {
            template += 1;
        }
        let transform = kp::post_rtc(&o.world, rtc).map(|v| v as f32);
        collated.templates[template].occurrences.push(InstanceOccurrence { mesh_index: refs.len(), transform });
        refs.push(InstanceMeshRef { positions: &[], normals: &[], indices: &[], origin: [0.0; 3], instance_meta: None, entity_id: o.entity_id, color: o.color, item_id: o.item_id });
        finishes.push(ifc_lite_processing::prepass::finish_to_wire(o.finish));
    }
    let mut buf = ifc_lite_geometry::encode_refs_with_finishes(&refs, &collated, &finishes);
    buf.reserve(8 + 8 * keys.len());
    for word in [KEY_TRAILER_MAGIC, keys.len() as u32].into_iter().chain(keys.iter().flat_map(|k| [(k >> 32) as u32, *k as u32])) {
        buf.extend_from_slice(&word.to_le_bytes());
    }
    buf
}

#[cfg(test)]
#[path = "global_instancing_tests.rs"]
mod tests;
