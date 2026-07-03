// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Phase-0 measurement spike for rotation-normalized GPU instancing.
//!
//! GOAL: answer ONE question with a real number before any renderer work — how
//! much MORE instancing dedup is *safely* available beyond the shipped exact-bit
//! tier (2.74x on merged_export), by also grouping element geometry that is
//! congruent up to a rigid rotation (orientation baked into the local
//! extrusion/profile/CSG rather than `IfcObjectPlacement`)?
//!
//! This module is MEASUREMENT-ONLY: no renderer, no production rep_identity
//! change, no cache. It operates on the PRE-PLACEMENT LOCAL meshes (the same
//! mesh state `compute_mesh_hash` saw — captured in `processing::tag_direct_instance`),
//! NOT the world-baked positions that `collate_instances` normally sees (the
//! frame-mismatch trap the design review flagged).
//!
//! SAFETY (so the measured number is an honest *lower* bound, never inflated like
//! the lossy-moments 10.66x probe): a cheap rotation-invariant signature only
//! BUCKETS candidates; an exact verifier DECIDES every merge — welded
//! vertex/triangle-count pre-gate, anchor-based correspondence, det=+1 Kabsch
//! (reflections stay separate), two-sided max (Hausdorff) deviation gate, AND a
//! triangle-set connectivity check (closes the same-cloud/different-triangulation
//! false-merge hole). A pair that cannot be PROVEN congruent stays distinct.
//!
//! Determinism is not required here (one-off native measurement), so nalgebra's
//! iterative eigensolver/SVD is fine; production would need the closed-form
//! Cardano path noted in the design.

// Whole module (mod.rs + engine + report) is a measurement-only spike driven
// solely by `congruence::tests`; it has no production caller. Narrowing
// `congruence` to `pub(crate)` in C3.2 surfaced it as dead in non-test builds
// (it was already unreachable by any external crate), so allow it module-wide.
#![allow(dead_code)]

mod engine;
mod report;

use self::engine::{build_welded, signature_keys, verify, Welded, SAFE_TOL};
use crate::mesh::Mesh;
use nalgebra::{Matrix3, Vector3};
use rustc_hash::FxHashMap;
use std::sync::{Mutex, OnceLock};

// `report::analyze_rigid_dedup`/`RigidDedupReport` have no consumer (production
// or test), so they are not re-exported here; they remain in `report` as spike
// artifacts under the module-level dead-code allow above.

// ----------------------------------------------------------------------------
// Analysis collector — populated in processing::tag_direct_instance under the
// IFC_LITE_INSTANCING_ANALYSIS flag (first-wins per rep_identity local geometry).
// ----------------------------------------------------------------------------

#[allow(clippy::type_complexity)]
static ANALYSIS_LOCALS: OnceLock<Mutex<FxHashMap<u128, Mesh>>> = OnceLock::new();

fn collector() -> &'static Mutex<FxHashMap<u128, Mesh>> {
    ANALYSIS_LOCALS.get_or_init(|| Mutex::new(FxHashMap::default()))
}

/// Whether the Phase-0 analysis collector is active.
pub fn analysis_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("IFC_LITE_INSTANCING_ANALYSIS").is_ok())
}

/// Record a representation's pre-placement local mesh (first occurrence wins).
pub fn record_local(rep_identity: u128, mesh: &Mesh) {
    if mesh.positions.is_empty() {
        return;
    }
    let mut map = collector().lock().expect("analysis collector poisoned");
    map.entry(rep_identity).or_insert_with(|| mesh.clone());
}

/// Drain the collected distinct local meshes, sorted by rep_identity for
/// deterministic analysis order.
///
/// No caller today (Phase-0 measurement spike, see module doc above);
/// narrowing `congruence` to `pub(crate)` in C3.2 surfaced that as unused.
pub fn take_locals() -> Vec<(u128, Mesh)> {
    let mut map = collector().lock().expect("analysis collector poisoned");
    let mut out: Vec<(u128, Mesh)> = std::mem::take(&mut *map).into_iter().collect();
    out.sort_by_key(|(k, _)| *k);
    out
}

// ----------------------------------------------------------------------------
// Production rigid tier (IFC_LITE_RIGID_INSTANCING): a shared cache that groups
// congruent-but-not-bit-identical local meshes onto one template + a recovered
// canonical->local transform, layered ON TOP of the exact-bit tier.
// ----------------------------------------------------------------------------

/// Whether the rotation-normalized rigid instancing tier is enabled.
pub fn rigid_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("IFC_LITE_RIGID_INSTANCING").is_ok())
}

// The rest of this "production rigid tier" (RigidClass..build_rigid_map) is
// driven only by `congruence::tests` today (Phase-0 measurement spike, see
// module doc above); narrowing `congruence` to `pub(crate)` in C3.2 surfaced
// it as unused in non-test builds. It was already unreachable by any
// external crate before that change.

/// Result of classifying a local mesh into the rigid tier.
#[derive(Clone, Copy)]
pub struct RigidClass {
    /// The rigid template's rep_identity (shared by all congruent occurrences).
    pub rigid_id: u128,
    /// Canonical(template-local) -> this(local) transform `C_k`, row-major. `None`
    /// when this mesh IS the template (identity).
    pub canonical_transform: Option<[f64; 16]>,
}

struct RigidTemplate {
    welded: Welded,
    rigid_id: u128,
    centroid: Vector3<f64>,
}

/// A reusable rigid-template cache: classify pre-placement local meshes into
/// congruence groups, recovering each occurrence's canonical→local transform.
///
/// Holds no global state, so the production integration runs it as a rayon
/// POST-PASS over the finished mesh slice (sharded by signature, or merged) — NOT
/// inline on the parallel streaming hot path, where a shared lock serialises the
/// geometry workers (measured: stalls the 986MB stream).
#[derive(Default)]
pub struct RigidCache {
    templates: Vec<RigidTemplate>,
    buckets: FxHashMap<u64, Vec<usize>>,
}

/// Row-major canonical->local transform `C = translate(c_cand) · R · translate(-c_tmpl)`.
fn canonical_transform_row_major(
    r: &Matrix3<f64>,
    c_tmpl: &Vector3<f64>,
    c_cand: &Vector3<f64>,
) -> [f64; 16] {
    let t = c_cand - r * c_tmpl; // translation column
    [
        r[(0, 0)], r[(0, 1)], r[(0, 2)], t.x,
        r[(1, 0)], r[(1, 1)], r[(1, 2)], t.y,
        r[(2, 0)], r[(2, 1)], r[(2, 2)], t.z,
        0.0, 0.0, 0.0, 1.0,
    ]
}

impl RigidCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Classify a pre-placement LOCAL mesh: find a congruent template (exactly
    /// verified — bucket proposes, [`verify`] decides) or register this as a new
    /// one. `exact_rep` is the mesh's exact-bit rep_identity, reused as the rigid
    /// id when registering. Returns None if the mesh can't be welded (too
    /// tiny/large) — caller keeps the exact tier.
    pub fn classify(&mut self, mesh: &Mesh, exact_rep: u128) -> Option<RigidClass> {
        let w = build_welded(mesh)?;
        let keys = signature_keys(&w);
        // Search every bucket this mesh hashes into for a congruent template.
        let mut seen: rustc_hash::FxHashSet<usize> = rustc_hash::FxHashSet::default();
        for k in &keys {
            if let Some(bucket) = self.buckets.get(k) {
                for &idx in bucket {
                    if !seen.insert(idx) {
                        continue;
                    }
                    let tmpl = &self.templates[idx];
                    let out = verify(&tmpl.welded, &w);
                    if out.corresponded && out.connectivity_ok && out.max_dev <= SAFE_TOL {
                        let c = canonical_transform_row_major(
                            &out.rotation,
                            &tmpl.centroid,
                            &w.centroid,
                        );
                        return Some(RigidClass {
                            rigid_id: tmpl.rigid_id,
                            canonical_transform: Some(c),
                        });
                    }
                }
            }
        }
        // No congruent template: register this mesh as a new template (identity C).
        let idx = self.templates.len();
        let centroid = w.centroid;
        self.templates.push(RigidTemplate {
            welded: w,
            rigid_id: exact_rep,
            centroid,
        });
        for k in keys {
            self.buckets.entry(k).or_default().push(idx);
        }
        Some(RigidClass {
            rigid_id: exact_rep,
            canonical_transform: None,
        })
    }
}

/// Production POST-PASS entry point: classify the DISTINCT pre-placement local
/// meshes (one per exact-bit rep_identity — occurrences of one exact rep share
/// bit-identical local geometry, so they share a rigid group + canonical
/// transform) into an `exact_rep -> RigidClass` map. The caller applies it to
/// every occurrence's `InstanceMeta` (rep_identity := rigid_id, canonical_transform
/// := C), then collates by the rigid id.
///
/// Runs over the ~distinct set (tens of thousands), NOT every occurrence, and off
/// the streaming hot path — the architecture the inline attempt got wrong. A
/// future optimisation shards `locals` by primary signature for rayon parallelism
/// (congruent meshes share a signature bucket, so shards are independent).
pub fn build_rigid_map(locals: &[(u128, Mesh)]) -> std::collections::HashMap<u128, RigidClass> {
    let mut cache = RigidCache::new();
    let mut map = std::collections::HashMap::with_capacity(locals.len());
    for (exact_rep, mesh) in locals {
        if let Some(cls) = cache.classify(mesh, *exact_rep) {
            map.insert(*exact_rep, cls);
        }
    }
    map
}

#[cfg(test)]
mod tests;
