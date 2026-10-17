// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C2-1 equivalence proof: the hand-rolled edge walks this module replaced are
//! kept here VERBATIM (`legacy`), and a seeded sweep over closed, open,
//! T-junction, degenerate, `-0.0` and far-from-origin meshes asserts that every
//! ledger query equals the walk it replaced. Deleted once the call sites have
//! been through a release (C2-5).

use super::{
    directed_closed, directed_closed_exact, edge_multiplicity_defects, strictly_paired_at,
    undirected_defect_count, Degenerate, EdgeLedger, EdgeMultiplicityDefects, VertexKey,
};
use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

mod legacy {
    use super::*;
    use std::collections::HashMap;

    type Q = (i64, i64, i64);

    pub(super) fn directed_edge_counts(mesh: &Mesh) -> FxHashMap<(Q, Q), i64> {
        let key = |i: u32| -> Q {
            let b = i as usize * 3;
            let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
            (q(mesh.positions[b]), q(mesh.positions[b + 1]), q(mesh.positions[b + 2]))
        };
        let mut edges: FxHashMap<(Q, Q), i64> = FxHashMap::default();
        for tri in mesh.indices.chunks_exact(3) {
            let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
            if ka == kb || kb == kc || kc == ka {
                continue;
            }
            for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
                *edges.entry((x, y)).or_insert(0) += 1;
                *edges.entry((y, x)).or_insert(0) -= 1;
            }
        }
        edges
    }

    pub(super) fn directed_closed(mesh: &Mesh) -> bool {
        let edges = directed_edge_counts(mesh);
        !edges.is_empty() && edges.values().all(|&count| count == 0)
    }

    pub(super) fn bad_edges(mesh: &Mesh) -> Vec<(Q, Q, i64)> {
        let mut bad: Vec<_> = directed_edge_counts(mesh)
            .into_iter()
            .filter(|&(_, c)| c > 0)
            .map(|((a, b), c)| (a, b, c))
            .collect();
        bad.sort_unstable();
        bad
    }

    pub(super) fn edge_multiplicity_defects(mesh: &Mesh) -> EdgeMultiplicityDefects {
        type K = (u32, u32, u32);
        let key = |i: u32| -> K {
            let b = i as usize * 3;
            let q = |v: f32| (if v == 0.0 { 0.0f32 } else { v }).to_bits();
            (q(mesh.positions[b]), q(mesh.positions[b + 1]), q(mesh.positions[b + 2]))
        };
        let mut edges: FxHashMap<(K, K), (u32, u32)> = FxHashMap::default();
        for tri in mesh.indices.chunks_exact(3) {
            let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
            if ka == kb || kb == kc || kc == ka {
                continue;
            }
            for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
                let (lo, hi, forward) = if x <= y { (x, y, true) } else { (y, x, false) };
                let slot = edges.entry((lo, hi)).or_insert((0, 0));
                if forward {
                    slot.0 += 1;
                } else {
                    slot.1 += 1;
                }
            }
        }
        let mut defects = EdgeMultiplicityDefects::default();
        for &(fwd, rev) in edges.values() {
            match fwd + rev {
                0 | 1 => {}
                2 if fwd == 1 && rev == 1 => {}
                2 => defects.same_direction += 1,
                _ => defects.over_used += 1,
            }
        }
        defects
    }

    pub(super) fn mesh_is_closed_exact(m: &Mesh) -> bool {
        let key = |i: u32| {
            let b = i as usize * 3;
            (m.positions[b].to_bits(), m.positions[b + 1].to_bits(), m.positions[b + 2].to_bits())
        };
        let mut edges: HashMap<_, i64> = HashMap::new();
        for t in m.indices.chunks_exact(3) {
            let k = [key(t[0]), key(t[1]), key(t[2])];
            for (u, v) in [(0usize, 1usize), (1, 2), (2, 0)] {
                if k[u] == k[v] {
                    return false;
                }
                *edges.entry((k[u], k[v])).or_insert(0) += 1;
                *edges.entry((k[v], k[u])).or_insert(0) -= 1;
            }
        }
        !m.indices.is_empty() && edges.values().all(|&c| c == 0)
    }

    pub(super) fn topology_defect_count(mesh: &Mesh) -> usize {
        let key = |i: u32| -> Q {
            let b = i as usize * 3;
            let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
            (q(mesh.positions[b]), q(mesh.positions[b + 1]), q(mesh.positions[b + 2]))
        };
        let mut edges: FxHashMap<(Q, Q), i32> = FxHashMap::default();
        for tri in mesh.indices.chunks_exact(3) {
            let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
            if ka == kb || kb == kc || kc == ka {
                continue;
            }
            for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
                let e = if x < y { (x, y) } else { (y, x) };
                *edges.entry(e).or_insert(0) += 1;
            }
        }
        if edges.is_empty() {
            return usize::MAX;
        }
        edges.values().filter(|&&c| c != 2).count()
    }

    pub(super) fn strictly_paired_at(mesh: &Mesh, per_unit: f64) -> bool {
        let key = |i: u32| {
            let b = i as usize * 3;
            [0, 1, 2].map(|k| (mesh.positions[b + k] as f64 * per_unit).round() as i64)
        };
        let mut uses: FxHashMap<([i64; 3], [i64; 3]), (u32, u32)> = FxHashMap::default();
        for t in mesh.indices.chunks_exact(3) {
            let (ka, kb, kc) = (key(t[0]), key(t[1]), key(t[2]));
            if ka == kb || kb == kc || kc == ka {
                continue;
            }
            for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
                let e = uses.entry((x.min(y), x.max(y))).or_insert((0, 0));
                if x < y {
                    e.0 += 1;
                } else {
                    e.1 += 1;
                }
            }
        }
        !uses.is_empty() && uses.values().all(|&u| u == (1, 1))
    }

    /// `cutter_is_closed_manifold`'s pairing, on an already-welded mesh.
    pub(super) fn welded_manifold(w: &Mesh) -> bool {
        let mut edge_uses: FxHashMap<(u32, u32), u32> = FxHashMap::default();
        for t in w.indices.chunks_exact(3) {
            if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                return false;
            }
            for &(a, b) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                let key = if a < b { (a, b) } else { (b, a) };
                *edge_uses.entry(key).or_insert(0) += 1;
            }
        }
        edge_uses.values().all(|&c| c == 2)
    }

    /// The T-junction pass's balance map: directed `(ka, kb)` tally, zero-length
    /// edges skipped one by one.
    pub(super) fn balance(mesh: &Mesh) -> FxHashMap<(Q, Q), i64> {
        let key = |i: u32| -> Q {
            let b = i as usize * 3;
            let q = |v: f32| (v as f64 * 1.0e4).round() as i64;
            (q(mesh.positions[b]), q(mesh.positions[b + 1]), q(mesh.positions[b + 2]))
        };
        let mut balance: FxHashMap<(Q, Q), i64> = FxHashMap::default();
        for t in mesh.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                let (ka, kb) = (key(a), key(b));
                if ka != kb {
                    *balance.entry((ka, kb)).or_insert(0) += 1;
                    *balance.entry((kb, ka)).or_insert(0) -= 1;
                }
            }
        }
        balance
    }
}

/// xorshift64*: a deterministic stream, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const QUADS: [[u32; 4]; 6] = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];

/// An outward-wound box at `lo` (offset to `far`), then perturbed by `kind`.
fn sample(rng: &mut Rng) -> Mesh {
    let far = [0.0f32, 1.0e3, -2.5e4, 3.0e5][rng.below(4) as usize];
    let jitter = [0.0f32, 3.0e-5, 2.0e-4, 1.0e-7][rng.below(4) as usize];
    let s = 0.5 + rng.below(4) as f32;
    let mut m = Mesh::new();
    for i in 0..8u32 {
        // Zero coordinates are emitted as -0.0 half of the time.
        let c = |bit: u32, flip: bool| {
            let v = s * bit as f32;
            if v == 0.0 && flip {
                -0.0
            } else {
                v + far
            }
        };
        let flip = rng.below(2) == 0;
        m.positions.extend([c(i & 1, flip), c((i >> 1) & 1, flip), c((i >> 2) & 1, flip)]);
        m.normals.extend([0.0, 0.0, 1.0]);
    }
    for q in QUADS {
        m.indices.extend([q[0], q[1], q[2], q[0], q[2], q[3]]);
    }
    for _ in 0..rng.below(4) {
        if m.indices.len() < 3 {
            break; // nothing left to mutilate
        }
        match rng.below(7) {
            0 => m.indices.truncate(m.indices.len() - 3), // open
            1 => {
                let t = rng.below(m.indices.len() as u64 / 3) as usize * 3;
                m.indices.swap(t + 1, t + 2); // flipped neighbour
            }
            2 => m.indices.extend_from_slice(&[0, 0, 1]), // degenerate by index
            3 => {
                // Sub-grid duplicate corner: a twin vertex a hair away.
                let b = m.positions.len();
                let src = rng.below(8) as usize * 3;
                for k in 0..3 {
                    m.positions.push(m.positions[src + k] + jitter);
                }
                m.normals.extend([0.0, 0.0, 1.0]);
                let t = rng.below(m.indices.len() as u64 / 3) as usize * 3;
                m.indices[t] = (b / 3) as u32;
            }
            4 => {
                let t = rng.below(m.indices.len() as u64 / 3) as usize * 3; // doubled sheet
                let tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
                m.indices.extend(tri);
            }
            5 => {
                // T-junction: split one triangle at an edge midpoint.
                let t = rng.below(m.indices.len() as u64 / 3) as usize * 3;
                let (a, b, c) = (m.indices[t] as usize * 3, m.indices[t + 1] as usize * 3, m.indices[t + 2]);
                let mid: Vec<f32> = (0..3).map(|k| 0.5 * (m.positions[a + k] + m.positions[b + k])).collect();
                let id = (m.positions.len() / 3) as u32;
                m.positions.extend(mid);
                m.normals.extend([0.0, 0.0, 1.0]);
                let (ia, ib) = (m.indices[t], m.indices[t + 1]);
                m.indices[t + 1] = id;
                m.indices.extend([id, ib, c]);
                let _ = ia;
            }
            _ => m.indices.clear(),
        }
    }
    m
}

#[test]
fn ledger_queries_equal_the_walks_they_replaced() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let (mut closed, mut open, mut degenerate) = (0, 0, 0);
    for case in 0..3000 {
        let m = sample(&mut rng);
        let ctx = format!("case {case}");
        assert_eq!(directed_closed(&m), legacy::directed_closed(&m), "{ctx}: directed_closed");
        let ledger = EdgeLedger::build(&m, VertexKey::GridDiv(1.0e-4), Degenerate::SkipTriangle);
        let mut bad: Vec<_> = ledger.unbalanced().map(|(a, b, n)| ((a[0], a[1], a[2]), (b[0], b[1], b[2]), n)).collect();
        bad.sort_unstable();
        assert_eq!(bad, legacy::bad_edges(&m), "{ctx}: the unmatched directed edges");
        assert_eq!(edge_multiplicity_defects(&m), legacy::edge_multiplicity_defects(&m), "{ctx}: multiplicity");
        assert_eq!(directed_closed_exact(&m), legacy::mesh_is_closed_exact(&m), "{ctx}: exact closure");
        assert_eq!(undirected_defect_count(&m), legacy::topology_defect_count(&m), "{ctx}: topology defects");
        for per_unit in [1.0e4, 1.0e3] {
            assert_eq!(
                strictly_paired_at(&m, per_unit),
                legacy::strictly_paired_at(&m, per_unit),
                "{ctx}: strictly paired at {per_unit}"
            );
        }
        // The index-keyed pairing, on the position-welded mesh.
        let welded = m.welded_by_position(1.0e-5);
        let index = EdgeLedger::build(&welded, VertexKey::Index, Degenerate::Reject);
        assert_eq!(
            !index.rejected() && index.undirected_defects() == 0,
            legacy::welded_manifold(&welded),
            "{ctx}: welded manifold"
        );
        // The T-junction balance, queried the way the pass queries it.
        let lattice = VertexKey::GridMul(1.0e4);
        let tj = EdgeLedger::build(&m, lattice, Degenerate::SkipEdge);
        for ((a, b), net) in legacy::balance(&m) {
            assert_eq!(tj.net([a.0, a.1, a.2], [b.0, b.1, b.2]), net, "{ctx}: balance");
        }
        match (directed_closed(&m), m.indices.is_empty()) {
            (true, _) => closed += 1,
            (false, true) => degenerate += 1,
            _ => open += 1,
        }
    }
    // The sweep must actually visit every class it claims to.
    assert!(closed > 100 && open > 100 && degenerate > 10, "closed {closed}, open {open}, empty {degenerate}");
}
