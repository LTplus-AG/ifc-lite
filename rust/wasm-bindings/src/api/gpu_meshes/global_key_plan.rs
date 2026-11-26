// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Content keys and template keys of the global instance plan.
//!
//! Most repetition in real models is not `IfcMappedItem`: it is elements whose
//! geometry items are structurally identical (identical direct solids). When
//! key planning is on, the streaming pre-pass hashes every job's geometry
//! items ([`ifc_lite_geometry::GeometryRouter::geometry_item_key`]) before the
//! first dispatch, counts each key over the jobs that host no opening, and
//! plans every key at or above the gate. Plan indices are dense and ordered by
//! each key's smallest member id, so the plan depends on the file only, never
//! on batch size or worker count.
//!
//! A template key is a u64 (`hi`, `lo`):
//! - mapped source: `hi` = the `IfcRepresentationMap` id (top bit clear),
//!   `lo` = a hash of the sub-mesh's topology;
//! - content key: `hi` = [`KEY_PLAN_TAG`] | plan index, `lo` = the sub-mesh's
//!   pre-placement identity folded with its topology (see [`template_key`]).
//!
//! Both halves name the template's exact local geometry: two meshes that
//! share a key share their local topology, so one template serves both.

use rustc_hash::{FxHashMap, FxHashSet};

/// No plan for this job.
pub(super) const KEY_PLAN_NONE: u32 = u32::MAX;
/// High bit of a content-key template key (mapped-source keys are ids).
pub(super) const KEY_PLAN_TAG: u32 = 0x8000_0000;
/// Sub-meshes of one planned element that may instance.
pub(super) const KEY_PLAN_MAX_SUBMESHES: usize = 16;
/// Plan indices must fit below the tag.
const KEY_PLAN_MAX_KEYS: usize = KEY_PLAN_TAG as usize;

/// The content-key plan for a job list.
#[derive(Default, Debug, PartialEq, Eq)]
pub(super) struct KeyPlan {
    /// Number of planned keys.
    pub keys: usize,
    /// Plan index per job (parallel to the job list), [`KEY_PLAN_NONE`] if unplanned.
    pub job_plan: Vec<u32>,
}

/// Whether a mapped source id can be a template key's `hi` word.
pub(super) fn is_mapped_key_id(id: u32) -> bool {
    id != 0 && id & KEY_PLAN_TAG == 0
}

/// Count `keys` (parallel to `job_ids`) over jobs not in `voided`; plan every
/// key with at least `gate` members, indexed by ascending smallest member id.
pub(super) fn build_key_plan(job_ids: &[u32], keys: &[Option<u128>], voided: &FxHashSet<u32>, gate: u32) -> KeyPlan {
    let eligible: Vec<Option<u128>> =
        job_ids.iter().zip(keys).map(|(id, key)| key.filter(|_| !voided.contains(id))).collect();
    let mut groups: FxHashMap<u128, (u32, u32)> = FxHashMap::default();
    for (&id, key) in job_ids.iter().zip(&eligible) {
        if let Some(k) = key {
            let group = groups.entry(*k).or_insert((0, u32::MAX));
            group.0 += 1;
            group.1 = group.1.min(id);
        }
    }
    let mut planned: Vec<(u32, u128)> =
        groups.into_iter().filter(|(_, (n, _))| *n >= gate).map(|(k, (_, first))| (first, k)).collect();
    planned.sort_unstable();
    planned.truncate(KEY_PLAN_MAX_KEYS);
    let index: FxHashMap<u128, u32> = planned.iter().enumerate().map(|(i, (_, k))| (*k, i as u32)).collect();
    let job_plan = eligible.iter().map(|key| key.and_then(|k| index.get(&k).copied()).unwrap_or(KEY_PLAN_NONE)).collect();
    KeyPlan { keys: planned.len(), job_plan }
}

/// Element ids that host an opening (`IfcRelVoidsElement.RelatingBuildingElement`).
pub(super) fn voided_hosts(content: &[u8], void_rels: &[(u32, usize, usize)]) -> FxHashSet<u32> {
    void_rels
        .iter()
        .filter_map(|&(_, s, e)| content.get(s..e))
        .flat_map(|bytes| ifc_lite_processing::discovery::record_refs_at(bytes, 4))
        .collect()
}

/// Word-wise FNV-1a over a mesh's topology (vertex count, sub-mesh index,
/// indices): deterministic on every target.
fn topology_hash(vertex_count: usize, sub: usize, indices: &[u32]) -> u32 {
    let mut h = ifc_lite_core::hash::Fnv1a64::new();
    h.mix_word(vertex_count as u64).mix_word(sub as u64);
    for &i in indices {
        h.mix_word(u64::from(i));
    }
    let h = h.finish();
    (h ^ (h >> 32)) as u32
}

/// Template key of sub-mesh `sub` of a planned element: `hi` names the plan
/// entry (a mapped source id, or [`KEY_PLAN_TAG`] | content-key plan index),
/// `lo` the mesh's pre-placement identity `rep` folded with its topology.
/// Occurrences of one plan entry that mesh differently (winding flipped by
/// orientation under a mirroring placement, triangles dropped by the
/// degenerate backstop, another material sub-mesh) get one template per
/// variant, never a wrong one.
pub(super) fn template_key(hi: u32, rep: u128, sub: usize, mesh: &ifc_lite_processing::MeshData) -> u64 {
    ((hi as u64) << 32) | (super::prepass_affinity::fold_u128_to_u32(rep) ^ topology_hash(mesh.positions.len() / 3, sub, &mesh.indices)) as u64
}

/// The `hi` word of a content-key plan entry.
pub(super) fn content_key_hi(index: u32) -> u32 {
    KEY_PLAN_TAG | index
}

/// A pre-RTC row-major world placement in the post-RTC frame: `T(-rtc) · M`.
pub(super) fn post_rtc(world: &[f64; 16], rtc: [f64; 3]) -> [f64; 16] {
    let mut m = *world;
    // Row-major: translation is column 3, scaled by the homogeneous m[15].
    m[3] -= rtc[0] * m[15];
    m[7] -= rtc[1] * m[15];
    m[11] -= rtc[2] * m[15];
    m
}

/// `m` taken back through the placement `world_row_major` (pre-RTC, row-major):
/// positions `W⁻¹ · (origin + p)` relative to the local bounding-box centre,
/// which becomes the template origin; normals by `Wᵀ`, renormalized. `None`
/// when `W` is singular or the mesh is empty.
pub(super) fn to_local(
    m: &ifc_lite_processing::MeshData,
    world_row_major: &[f64; 16],
    rtc: [f64; 3],
) -> Option<ifc_lite_geometry::Mesh> {
    if m.positions.is_empty() || m.indices.is_empty() {
        return None;
    }
    let w = ifc_lite_geometry::Matrix4::<f64>::from_row_slice(&post_rtc(world_row_major, rtc));
    let inv = w.try_inverse()?;
    let local: Vec<[f64; 3]> = m
        .positions
        .chunks_exact(3)
        .map(|p| {
            let q = [m.origin[0] + p[0] as f64, m.origin[1] + p[1] as f64, m.origin[2] + p[2] as f64, 1.0];
            let r = |row: usize| (0..4).map(|c| inv[(row, c)] * q[c]).sum::<f64>();
            let wq = r(3);
            [r(0) / wq, r(1) / wq, r(2) / wq]
        })
        .collect();
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in &local {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let origin: [f64; 3] = std::array::from_fn(|k| 0.5 * (lo[k] + hi[k]));
    if !origin.iter().all(|v| v.is_finite()) {
        return None;
    }
    let mut out = ifc_lite_geometry::Mesh::new();
    out.origin = origin;
    out.positions = local.iter().flat_map(|p| std::array::from_fn::<f32, 3, _>(|k| (p[k] - origin[k]) as f32)).collect();
    out.normals.reserve(m.normals.len());
    for n in m.normals.chunks_exact(3) {
        // Wᵀ on the linear part: v_i = Σ_r w[r][i] · n_r.
        let v: [f64; 3] = std::array::from_fn(|i| (0..3).map(|r| w[(r, i)] * n[r] as f64).sum());
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        let s = if len > 0.0 { 1.0 / len } else { 1.0 };
        out.normals.extend_from_slice(&[(v[0] * s) as f32, (v[1] * s) as f32, (v[2] * s) as f32]);
    }
    out.indices = m.indices.clone();
    Some(out)
}

#[cfg(test)]
#[path = "global_key_plan_tests.rs"]
mod tests;
