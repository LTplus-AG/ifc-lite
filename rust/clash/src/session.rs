// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public clash session: ingest element geometry, then run rules.
//!
//! The broad phase mirrors `packages/clash/src/engine-ts/broad.ts` (BVH over
//! group_a element AABBs, query each group_b element inflated by `margin`); the
//! narrow phase delegates to [`crate::narrow::test_pair`]. Records carry GLOBAL
//! element indices.

use std::cell::RefCell;
use std::collections::HashSet;

use crate::aabb::Aabb;
use crate::bvh::Bvh;
use crate::narrow::{test_pair, ClashStatus};
use crate::tri_mesh::TriMesh;

/// One classified clash between two elements (GLOBAL element indices).
pub struct ClashRecord {
    pub a: u32,
    pub b: u32,
    pub status: ClashStatus,
    pub distance: f64,
    pub point: [f64; 3],
    /// `[minx, miny, minz, maxx, maxy, maxz]`.
    pub bounds: [f64; 6],
}

/// The records produced by a single rule run.
pub struct RuleResult {
    pub records: Vec<ClashRecord>,
}

/// Per-element geometry plus a lazily built per-triangle BVH.
struct Element {
    aabb: Aabb,
    positions: Vec<f64>,
    indices: Vec<u32>,
    /// Built on first narrow-phase use, then cached for the session lifetime.
    mesh: RefCell<Option<TriMesh>>,
}

/// A clash session: stores per-element geometry, element AABBs, and caches the
/// per-element triangle BVHs that the narrow phase needs.
pub struct ClashSession {
    elements: Vec<Element>,
}

impl Default for ClashSession {
    fn default() -> Self {
        Self::new()
    }
}

impl ClashSession {
    pub fn new() -> Self {
        Self {
            elements: Vec::new(),
        }
    }

    /// Ingest `N` elements from flat arenas.
    ///
    /// - `positions`: concatenated per-element vertex coords (`x, y, z, ...`).
    /// - `pos_ranges`: 2 per element = `[float_offset, float_len]`.
    /// - `indices`: concatenated per-element LOCAL (0-based within that
    ///   element's vertices) triangle indices.
    /// - `idx_ranges`: 2 per element = `[idx_offset, idx_len]`.
    /// - `aabbs`: 6 per element = `[minx, miny, minz, maxx, maxy, maxz]`.
    ///
    /// Vertex/AABB coords are `f32`-sourced; they are stored and computed in
    /// `f64`.
    pub fn ingest(
        &mut self,
        positions: &[f32],
        pos_ranges: &[u32],
        indices: &[u32],
        idx_ranges: &[u32],
        aabbs: &[f32],
    ) {
        // Reset first, so a reused session does not accumulate stale elements.
        self.elements.clear();
        let n = pos_ranges.len() / 2;
        self.elements.reserve(n);
        for e in 0..n {
            // Default to an empty element so global indices stay aligned with the
            // caller's arena even if this element's slices are malformed — no
            // panic (which under `panic = abort` would poison the shared wasm
            // module); it simply never produces a clash.
            let mut element_positions: Vec<f64> = Vec::new();
            let mut element_indices: Vec<u32> = Vec::new();
            let mut aabb = Aabb::new([0.0; 3], [0.0; 3]);

            let ranges_ok = e * 2 + 1 < idx_ranges.len() && e * 6 + 5 < aabbs.len();
            if ranges_ok {
                let pos_off = pos_ranges[e * 2] as usize;
                let pos_len = pos_ranges[e * 2 + 1] as usize;
                let idx_off = idx_ranges[e * 2] as usize;
                let idx_len = idx_ranges[e * 2 + 1] as usize;
                if pos_off + pos_len <= positions.len() && idx_off + idx_len <= indices.len() {
                    element_positions = positions[pos_off..pos_off + pos_len]
                        .iter()
                        .map(|&v| v as f64)
                        .collect();
                    element_indices = indices[idx_off..idx_off + idx_len].to_vec();
                    let ab = e * 6;
                    aabb = Aabb::new(
                        [aabbs[ab] as f64, aabbs[ab + 1] as f64, aabbs[ab + 2] as f64],
                        [aabbs[ab + 3] as f64, aabbs[ab + 4] as f64, aabbs[ab + 5] as f64],
                    );
                }
            }

            self.elements.push(Element {
                aabb,
                positions: element_positions,
                indices: element_indices,
                mesh: RefCell::new(None),
            });
        }
    }

    /// Build (or reuse) the cached triangle mesh for global element `idx` and
    /// run `f` against it. Avoids re-borrowing the `RefCell` across the call.
    fn with_mesh<R>(&self, idx: u32, f: impl FnOnce(&TriMesh) -> R) -> R {
        let element = &self.elements[idx as usize];
        {
            let mut slot = element.mesh.borrow_mut();
            if slot.is_none() {
                *slot = Some(TriMesh::new(
                    element.positions.clone(),
                    element.indices.clone(),
                ));
            }
        }
        let slot = element.mesh.borrow();
        f(slot.as_ref().expect("mesh built above"))
    }

    /// Run one rule.
    ///
    /// `group_a` / `group_b` are GLOBAL element indices. An empty `group_b`
    /// requests a self-clash within `group_a` (pairs with `i < j` by position
    /// in `group_a`). `mode`: `0` = hard, `1` = clearance. Records carry GLOBAL
    /// element indices.
    #[allow(clippy::too_many_arguments)]
    pub fn run_rule(
        &self,
        group_a: &[u32],
        group_b: &[u32],
        mode: u8,
        tolerance: f64,
        clearance: f64,
        report_touch: bool,
    ) -> RuleResult {
        let is_clearance = mode == 1;
        let margin = tolerance.max(if is_clearance { clearance } else { 0.0 });

        let pairs = self.candidate_pairs(group_a, group_b, margin);

        let mut records = Vec::new();
        for (a_global, b_global) in pairs {
            let result = self.with_mesh(a_global, |mesh_a| {
                self.with_mesh(b_global, |mesh_b| {
                    test_pair(
                        &self.elements[a_global as usize].aabb,
                        mesh_a,
                        &self.elements[b_global as usize].aabb,
                        mesh_b,
                        mode,
                        tolerance,
                        clearance,
                        report_touch,
                    )
                })
            });
            if let Some(r) = result {
                records.push(ClashRecord {
                    a: a_global,
                    b: b_global,
                    status: r.status,
                    distance: r.distance,
                    point: r.point,
                    bounds: [
                        r.bounds.min[0],
                        r.bounds.min[1],
                        r.bounds.min[2],
                        r.bounds.max[0],
                        r.bounds.max[1],
                        r.bounds.max[2],
                    ],
                });
            }
        }

        RuleResult { records }
    }

    /// Broad-phase candidate global-index pairs.
    ///
    /// Builds a BVH over `group_a`'s element AABBs. For a group pair, each
    /// `group_b` element queries inflated by `margin`; duplicates are removed
    /// and identical element indices are skipped. For self-clash (`group_b`
    /// empty) each `group_a` element queries the BVH, keeping pairs whose
    /// position in `group_a` satisfies `i < j`.
    fn candidate_pairs(
        &self,
        group_a_in: &[u32],
        group_b_in: &[u32],
        margin: f64,
    ) -> Vec<(u32, u32)> {
        // Defensively drop any out-of-range global indices at the public boundary.
        let n = self.elements.len() as u32;
        let group_a: Vec<u32> = group_a_in.iter().copied().filter(|&g| g < n).collect();
        let group_b: Vec<u32> = group_b_in.iter().copied().filter(|&g| g < n).collect();
        if group_a.is_empty() {
            return Vec::new();
        }

        // BVH item id is the POSITION in group_a, so query hits map back to the
        // group_a slot (and thus the global element index).
        let items: Vec<(u32, Aabb)> = group_a
            .iter()
            .enumerate()
            .map(|(i, &g)| (i as u32, self.elements[g as usize].aabb))
            .collect();
        let bvh = Bvh::build(&items);

        let mut pairs: Vec<(u32, u32)> = Vec::new();

        if !group_b.is_empty() {
            let mut seen: HashSet<(u32, u32)> = HashSet::new();
            for &b_global in &group_b {
                let b_aabb = self.elements[b_global as usize].aabb;
                let hits = bvh.query_aabb(&b_aabb.inflate(margin));
                for i in hits {
                    let a_global = group_a[i as usize];
                    // Skip identical element index (same entity).
                    if a_global == b_global {
                        continue;
                    }
                    let dedup = if a_global < b_global {
                        (a_global, b_global)
                    } else {
                        (b_global, a_global)
                    };
                    if !seen.insert(dedup) {
                        continue;
                    }
                    pairs.push((a_global, b_global));
                }
            }
        } else {
            for (i, &a_global) in group_a.iter().enumerate() {
                let a_aabb = self.elements[a_global as usize].aabb;
                let hits = bvh.query_aabb(&a_aabb.inflate(margin));
                for j in hits {
                    let j = j as usize;
                    if j <= i {
                        continue;
                    }
                    let b_global = group_a[j];
                    // Skip identical element index (same entity).
                    if a_global == b_global {
                        continue;
                    }
                    pairs.push((a_global, b_global));
                }
            }
        }

        pairs
    }
}
