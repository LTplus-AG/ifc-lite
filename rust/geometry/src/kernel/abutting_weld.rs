// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The plane census and the weld for [`super::abutting`]: given a group of
//! operands, make the facing axis-aligned planes that are at most one
//! [`SNAP_GRID`] cell apart coincide, so the N-ary union can merge them.
//!
//! Split from the parent to keep both files under the module-size ratchet. The
//! parent owns grouping, the acceptance gate and the ordering guarantee; this
//! file owns "which planes face each other" and "move them onto one plane".
//! [`super::abutting`]'s module doc states the rule and all of its limits.

use super::super::arrangement::Tri;
use super::super::mesh_bridge::SNAP_GRID;
use crate::union_find::UnionFind;
use std::borrow::Cow;
use std::collections::HashMap;

/// Whether some axis carries a facing plane pair between the two components.
///
/// Symmetric in `a` and `b` by construction: the disjunction below is the same
/// set of pairs read from either side. That matters because this decides group
/// membership, and the caller's component order must not change which
/// components merge.
pub(super) fn face_each_other(a: &[Tri], b: &[Tri]) -> bool {
    (0..3).any(|k| {
        let (plus_a, minus_a) = axis_planes(a, k);
        let (plus_b, minus_b) = axis_planes(b, k);
        faces_across(&plus_a, &minus_b) || faces_across(&plus_b, &minus_a)
    })
}

/// Some `+k` plane with a `-k` plane at most one cell ABOVE it, footprints
/// overlapping: two solids that meet at that plane rather than overlap.
fn faces_across(plus: &[AxisPlane], minus: &[AxisPlane]) -> bool {
    plus.iter().any(|p| {
        minus
            .iter()
            .any(|m| (0.0..=SNAP_GRID).contains(&(m.c - p.c)) && footprints_overlap(p, m))
    })
}

/// An axis-aligned face plane of one component: its constant coordinate and the
/// extent of its triangles over the other two axes.
#[derive(Clone, Copy)]
struct AxisPlane {
    c: f64,
    lo: [f64; 2],
    hi: [f64; 2],
}

/// The `+e_k` and `-e_k` face planes of one component: every triangle whose
/// three vertices share the `k` coordinate bit for bit, grouped by that
/// coordinate.
type AxisPlanes = (Vec<AxisPlane>, Vec<AxisPlane>);

fn axis_planes(tris: &[Tri], k: usize) -> AxisPlanes {
    let (a, b) = ((k + 1) % 3, (k + 2) % 3);
    let mut plus: HashMap<u64, AxisPlane> = HashMap::new();
    let mut minus: HashMap<u64, AxisPlane> = HashMap::new();
    for t in tris {
        let c = t[0][k];
        if t[1][k].to_bits() != c.to_bits() || t[2][k].to_bits() != c.to_bits() {
            continue;
        }
        // Normal component along k, from the two in-plane edges. Both edges are
        // differences within ONE cutter, so the products stay exact in f64 at
        // any world position a cutter reaches, and the value is of the order of
        // the face area: far from the zero this branch tests for.
        let (e1, e2) = (
            [t[1][a] - t[0][a], t[1][b] - t[0][b]],
            [t[2][a] - t[0][a], t[2][b] - t[0][b]],
        );
        let nk = e1[0] * e2[1] - e1[1] * e2[0];
        let side = if nk > 0.0 {
            &mut plus
        } else if nk < 0.0 {
            &mut minus
        } else {
            continue;
        };
        let p = side.entry(c.to_bits()).or_insert(AxisPlane {
            c,
            lo: [f64::INFINITY; 2],
            hi: [f64::NEG_INFINITY; 2],
        });
        for v in t {
            p.lo[0] = p.lo[0].min(v[a]);
            p.hi[0] = p.hi[0].max(v[a]);
            p.lo[1] = p.lo[1].min(v[b]);
            p.hi[1] = p.hi[1].max(v[b]);
        }
    }
    // Deterministic order: by coordinate. Distinct planes have distinct
    // coordinates, so this is a total order.
    let sorted = |m: HashMap<u64, AxisPlane>| {
        let mut v: Vec<AxisPlane> = m.into_values().collect();
        v.sort_by(|x, y| x.c.total_cmp(&y.c));
        v
    };
    (sorted(plus), sorted(minus))
}

/// Positive overlap on both in-plane axes: a shared corner or edge does not count.
fn footprints_overlap(p: &AxisPlane, q: &AxisPlane) -> bool {
    p.lo[0] < q.hi[0] && q.lo[0] < p.hi[0] && p.lo[1] < q.hi[1] && q.lo[1] < p.hi[1]
}

/// What one axis coordinate carries across the whole group.
struct CoordFaces {
    c: f64,
    /// Components with a `+k` face plane at `c`, and with a `-k` one.
    plus: Vec<usize>,
    minus: Vec<usize>,
}

/// Plan and apply ALL of one axis's welds against ONE census of the group.
///
/// Returns whether anything moved, and whether some facing pair was already
/// coincident — that needs no weld but still needs the union.
///
/// Planning globally is what bounds the result. Welding pair by pair, each pair
/// re-reading the geometry the last one left, let a coordinate move a cell per
/// anchor (so n chained anchors moved it n cells, past the one-cell rule the
/// safety argument rests on) and let two anchors in DIFFERENT components pull
/// one coordinate opposite ways, where the second pull silently lost and left
/// its own seam a cell wider. Here each coordinate belongs to one class and
/// moves at most once.
fn weld_axis(ops: &mut [Cow<'_, [Tri]>], k: usize) -> (bool, bool) {
    let censuses: Vec<AxisPlanes> = ops.iter().map(|o| axis_planes(o, k)).collect();
    // Every distinct coordinate the group's axis planes sit on.
    let mut coords: Vec<CoordFaces> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    for (comp, (plus, minus)) in censuses.iter().enumerate() {
        for (planes, is_plus) in [(plus, true), (minus, false)] {
            for p in planes {
                let at = *index.entry(p.c.to_bits()).or_insert(coords.len());
                if at == coords.len() {
                    coords.push(CoordFaces {
                        c: p.c,
                        plus: Vec::new(),
                        minus: Vec::new(),
                    });
                }
                if is_plus {
                    coords[at].plus.push(comp);
                } else {
                    coords[at].minus.push(comp);
                }
            }
        }
    }
    // A facing pair joins the two coordinates it spans.
    let mut classes = UnionFind::new(coords.len());
    let mut coincident = false;
    for (i, (plus_i, _)) in censuses.iter().enumerate() {
        for (j, (_, minus_j)) in censuses.iter().enumerate() {
            if i == j {
                continue;
            }
            for p in plus_i {
                for m in minus_j {
                    let gap = m.c - p.c;
                    if !(0.0..=SNAP_GRID).contains(&gap) || !footprints_overlap(p, m) {
                        continue;
                    }
                    if gap == 0.0 {
                        coincident = true;
                        continue;
                    }
                    classes.union(index[&p.c.to_bits()] as u32, index[&m.c.to_bits()] as u32);
                }
            }
        }
    }
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); coords.len()];
    for i in 0..coords.len() {
        members[classes.find(i as u32) as usize].push(i);
    }
    let mut welded = false;
    for class in &members {
        let [a, b] = class[..] else { continue };
        let (lo, hi) = if coords[a].c <= coords[b].c { (a, b) } else { (b, a) };
        // Accept only the shape a snap can produce from one authored plane: two
        // coordinates at most a cell apart, the lower carrying `+k` faces ONLY
        // and the upper `-k` faces ONLY. Anything else — a third coordinate in
        // the chain, or one coordinate carrying both sides — is a pull in two
        // directions at once, which an unindexed soup cannot honour, so it is
        // left alone. Because no `+k` face ever moves, nothing shrinks and the
        // weld cannot create an overlap.
        if coords[hi].c - coords[lo].c > SNAP_GRID
            || !coords[lo].minus.is_empty()
            || !coords[hi].plus.is_empty()
            || coords[lo].plus.is_empty()
            || coords[hi].minus.is_empty()
            // A component spanning the pair would collapse to zero thickness.
            || coords[hi].minus.iter().any(|c| coords[lo].plus.contains(c))
        {
            continue;
        }
        let (to, from) = (coords[lo].c, coords[hi].c.to_bits());
        for &comp in &coords[hi].minus {
            for t in ops[comp].to_mut().iter_mut() {
                for v in t.iter_mut() {
                    if v[k].to_bits() == from {
                        v[k] = to;
                    }
                }
            }
        }
        welded = true;
    }
    (welded, coincident)
}

/// Weld the group's facing axis-aligned planes onto one plane each. `true` when
/// the group is now coincident along at least one facing pair, so the union has
/// something to merge.
///
/// Each axis is planned against the geometry the previous axis left, which is
/// sound: a weld along `k` changes no other axis's coordinates, only the
/// in-plane extents those axes' footprints are measured over.
pub(super) fn weld_facing_planes(ops: &mut [Cow<'_, [Tri]>]) -> bool {
    let mut ready = false;
    for k in 0..3 {
        let (welded, coincident) = weld_axis(ops, k);
        ready |= welded || coincident;
    }
    ready
}

