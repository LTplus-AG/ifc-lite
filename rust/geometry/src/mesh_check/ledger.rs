// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The edge ledger: one hash walk over a triangle soup that every closure,
//! pairing and multiplicity question is answered from.
//!
//! Each undirected edge `{a, b}` owns one slot `(fwd, rev)`: the number of
//! triangle uses running `lo -> hi` and `hi -> lo`, where `lo < hi` in the key
//! order. Every walk this crate used to hand-roll is a query on that pair:
//!
//! | Question | Query |
//! |---|---|
//! | signed directed tally of `(a, b)` | `fwd - rev` ([`EdgeLedger::net`]) |
//! | undirected use count | `fwd + rev` ([`EdgeLedger::undirected_defects`]) |
//! | strictly paired (one use each way) | `(1, 1)` ([`EdgeLedger::strictly_paired`]) |
//!
//! The vertex key and the degenerate-triangle rule are the caller's choice and
//! stay the caller's: [`VertexKey`] and [`Degenerate`] name the spellings the
//! gates already used. The ledger never unifies them (two quantiser spellings
//! disagree at `.5` ties, and that is tolerance work, not refactoring).

use super::closure::EdgeMultiplicityDefects;
use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

/// A quantised or bit-exact vertex identity.
pub type Key3 = [i64; 3];

/// How a vertex becomes a hash key.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VertexKey {
    /// The raw `f32` bits of the position. `-0.0` and `+0.0` are two points.
    Bits,
    /// The raw `f32` bits with `-0.0` folded to `+0.0`.
    BitsZeroFolded,
    /// `(v as f64 / q).round() as i64`: a grid of pitch `q` (world units).
    GridDiv(f64),
    /// `(v as f64 * k).round() as i64`: a grid of `k` cells per unit.
    GridMul(f64),
    /// The vertex index itself, for a mesh the caller already welded.
    Index,
}

#[inline]
fn bits(p: [f32; 3]) -> Key3 {
    p.map(|c| i64::from(c.to_bits()))
}

#[inline]
fn bits_zero_folded(p: [f32; 3]) -> Key3 {
    p.map(|c| i64::from((if c == 0.0 { 0.0f32 } else { c }).to_bits()))
}

#[inline]
fn grid_div(p: [f32; 3], q: f64) -> Key3 {
    p.map(|c| (f64::from(c) / q).round() as i64)
}

#[inline]
fn grid_mul(p: [f32; 3], k: f64) -> Key3 {
    p.map(|c| (f64::from(c) * k).round() as i64)
}

impl VertexKey {
    /// The key of position `p`, or `None` for [`VertexKey::Index`], which has
    /// no meaning without a vertex index.
    #[inline]
    pub fn point(self, p: [f32; 3]) -> Option<Key3> {
        match self {
            Self::Bits => Some(bits(p)),
            Self::BitsZeroFolded => Some(bits_zero_folded(p)),
            Self::GridDiv(q) => Some(grid_div(p, q)),
            Self::GridMul(k) => Some(grid_mul(p, k)),
            Self::Index => None,
        }
    }
}

/// What the walk does with a triangle whose corners collapse onto one key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Degenerate {
    /// Ignore the whole triangle (it bounds no area).
    SkipTriangle,
    /// Ignore only the zero-length edge; the other two edges still count.
    SkipEdge,
    /// Stop: the ledger is [`rejected`](EdgeLedger::rejected) and every
    /// all-edges predicate on it is `false`.
    Reject,
}

/// Per-undirected-edge directed use counts of a triangle soup.
pub struct EdgeLedger {
    /// `(lo, hi) -> (uses lo->hi, uses hi->lo)`, `lo < hi`.
    uses: FxHashMap<(Key3, Key3), (u32, u32)>,
    rejected: bool,
}

#[inline]
fn position(positions: &[f32], i: u32) -> [f32; 3] {
    let b = i as usize * 3;
    [positions[b], positions[b + 1], positions[b + 2]]
}

impl EdgeLedger {
    /// Walk `mesh` once. An out-of-range index panics, as every old walk did.
    pub fn build(mesh: &Mesh, key: VertexKey, degenerate: Degenerate) -> Self {
        Self::build_raw(&mesh.positions, &mesh.indices, key, degenerate)
    }

    /// [`build`](Self::build) over raw `positions` (xyz triples) and `indices`.
    pub fn build_raw(positions: &[f32], indices: &[u32], key: VertexKey, degenerate: Degenerate) -> Self {
        // One monomorphised walk per key spelling: the key is a closure, not a
        // branch in the loop.
        let at = |i: u32| position(positions, i);
        match key {
            VertexKey::Bits => Self::walk(indices, degenerate, |i| bits(at(i))),
            VertexKey::BitsZeroFolded => Self::walk(indices, degenerate, |i| bits_zero_folded(at(i))),
            VertexKey::GridDiv(q) => Self::walk(indices, degenerate, |i| grid_div(at(i), q)),
            VertexKey::GridMul(k) => Self::walk(indices, degenerate, |i| grid_mul(at(i), k)),
            VertexKey::Index => Self::walk(indices, degenerate, |i| [i64::from(i), 0, 0]),
        }
    }

    #[inline]
    fn walk(indices: &[u32], degenerate: Degenerate, key: impl Fn(u32) -> Key3) -> Self {
        let mut ledger = Self { uses: FxHashMap::default(), rejected: false };
        for t in indices.chunks_exact(3) {
            let (ka, kb, kc) = (key(t[0]), key(t[1]), key(t[2]));
            if degenerate != Degenerate::SkipEdge && (ka == kb || kb == kc || kc == ka) {
                if degenerate == Degenerate::Reject {
                    ledger.rejected = true;
                    break;
                }
                continue;
            }
            for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
                if x == y {
                    continue;
                }
                let (lo, hi, forward) = if x < y { (x, y, true) } else { (y, x, false) };
                let slot = ledger.uses.entry((lo, hi)).or_insert((0, 0));
                if forward {
                    slot.0 += 1;
                } else {
                    slot.1 += 1;
                }
            }
        }
        ledger
    }

    /// No edge was recorded (no triangle survived the degenerate rule).
    pub fn is_empty(&self) -> bool {
        self.uses.is_empty()
    }

    /// The walk stopped at a degenerate triangle under [`Degenerate::Reject`].
    pub fn rejected(&self) -> bool {
        self.rejected
    }

    /// Every edge is used as often forward as backward. Vacuously true on an
    /// empty ledger; false on a rejected one.
    pub fn directed_closed(&self) -> bool {
        !self.rejected && self.uses.values().all(|&(f, r)| f == r)
    }

    /// Every edge is used exactly once each way. Vacuously true on an empty
    /// ledger; false on a rejected one.
    pub fn strictly_paired(&self) -> bool {
        !self.rejected && self.uses.values().all(|&u| u == (1, 1))
    }

    /// Edges whose total use count is not two (open or non-manifold).
    pub fn undirected_defects(&self) -> usize {
        self.uses.values().filter(|&&(f, r)| f + r != 2).count()
    }

    /// The signed tally of directed edge `a -> b`: uses `a->b` minus uses
    /// `b->a`. Zero for an edge never seen.
    pub fn net(&self, a: Key3, b: Key3) -> i64 {
        let (lo, hi, sign) = if a < b { (a, b, 1) } else { (b, a, -1) };
        self.uses.get(&(lo, hi)).map_or(0, |&(f, r)| sign * (i64::from(f) - i64::from(r)))
    }

    /// Edges with a net directed tally, oriented so the tally is positive.
    /// Iteration order is the map's: callers that need an order sort.
    pub fn unbalanced(&self) -> impl Iterator<Item = (Key3, Key3, i64)> + '_ {
        self.uses.iter().filter_map(|(&(lo, hi), &(f, r))| {
            let net = i64::from(f) - i64::from(r);
            match net {
                0 => None,
                n if n > 0 => Some((lo, hi, n)),
                n => Some((hi, lo, -n)),
            }
        })
    }

    /// The two defects a signed tally cannot represent: more than two uses,
    /// and exactly two uses running the same way. An edge used once is an open
    /// boundary, not a multiplicity defect.
    pub fn multiplicity_defects(&self) -> EdgeMultiplicityDefects {
        let mut defects = EdgeMultiplicityDefects::default();
        for &(f, r) in self.uses.values() {
            match f + r {
                0 | 1 => {}
                2 if f == 1 && r == 1 => {}
                2 => defects.same_direction += 1,
                _ => defects.over_used += 1,
            }
        }
        defects
    }
}
