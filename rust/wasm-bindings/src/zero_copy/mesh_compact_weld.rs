// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Welding one mesh onto its lattice window for the compact encoder
//! (`mesh_compact.rs`): quantize, merge the vertices that share a lattice
//! node, keep corners that face opposite sides apart, and remap the triangles.

use super::super::MeshDataJs;
use super::{Refusal, Q_MAX};

/// Share of a mesh's area that may collapse on the lattice before it moves to
/// a finer level (the renderer's `MAX_COLLAPSED_AREA_FRACTION`, #9068).
const MAX_COLLAPSED_AREA_FRACTION: f64 = 0.01;

/// Share of a mesh's area whose face may flip or turn past 20° on the lattice (without
/// collapsing) before it moves to a finer level (the renderer's `MAX_TURNED_AREA_FRACTION`,
/// #11444). The shader shades a face by its snapped normal: a Ø12 mm rebar collapses nothing on
/// the 1 mm lattice but turns at least 10% of its area past 20°; chamfered pieces stay under 5%.
const MAX_TURNED_AREA_FRACTION: f64 = 0.05;
/// cos² 20°, the turn `MAX_TURNED_AREA_FRACTION` counts (the renderer's `MIN_LATTICE_COS2`).
const MIN_LATTICE_COS2: f64 = 0.883_022_221_559_489_1;

/// A corner is witnessed by its node's stored normal when the cosine between
/// them is above this. The fragment shader orients a face's derivative normal
/// by the sign of its dot product with the vertex normal and ignores a vertex
/// normal under cos² = 0.03 (cos = 0.173, `main.wgsl.ts`); the margin above
/// that covers the oct encoding's error (about 1.4°).
const MIN_WITNESS_COSINE: f64 = 0.2;

/// `round(x)` with ties up (JS `Math.round`), on the native `f64::floor`;
/// `f64::round` is a libm call in wasm.
#[inline]
pub(super) fn round_half_up(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Sort `order` by a strict total order `less`, in place (heapsort: O(n log n), no allocation).
///
/// A `slice::sort*` call here costs 8 KB of engine wasm: each comparator is its own instantiation
/// of the standard sort. A batch holds a few thousand rows at most, so this is not a hot path.
pub(super) fn sort_indices(order: &mut [u32], less: impl Fn(u32, u32) -> bool) {
    let sift_down = |order: &mut [u32], mut root: usize, end: usize| loop {
        let mut child = 2 * root + 1;
        if child >= end {
            break;
        }
        if child + 1 < end && less(order[child], order[child + 1]) {
            child += 1;
        }
        if !less(order[root], order[child]) {
            break;
        }
        order.swap(root, child);
        root = child;
    };
    let n = order.len();
    for root in (0..n / 2).rev() {
        sift_down(order, root, n);
    }
    for end in (1..n).rev() {
        order.swap(0, end);
        sift_down(order, 0, end);
    }
}

/// Reusable per-mesh scratch, so encoding a batch allocates once.
#[derive(Default)]
pub(super) struct Scratch {
    weld: WeldTable,
    /// Welded vertices: u16 offsets from the window, and the sum of the normals welded into each.
    pub(super) nodes: Vec<[u16; 3]>,
    pub(super) normal_sums: Vec<[f64; 3]>,
    /// Source vertex -> welded vertex.
    remap: Vec<u16>,
    /// Remapped triangles, degenerate ones dropped.
    pub(super) tris: Vec<u16>,
    /// Per welded vertex: one of its corners is not witnessed by the stored normal.
    unwitnessed: Vec<bool>,
    /// The first weld, kept while unwitnessed nodes are split.
    first_nodes: Vec<[u16; 3]>,
    first_remap: Vec<u16>,
}

/// Open-addressing map from lattice node to welded vertex, reset per mesh. A
/// hash-map entry per vertex cost four times the getter copy it replaces on
/// dense meshes; linear probing over a power-of-two table of plain u64 keys
/// does not.
#[derive(Default)]
struct WeldTable {
    keys: Vec<u64>,
    vals: Vec<u16>,
    mask: usize,
}

/// Slots that keep the load factor at or under one half for the most keys a mesh can insert.
const MAX_SLOTS: usize = 1 << 17;

/// No key reaches this: a key is three u16 offsets and a 3-bit side class.
const EMPTY_KEY: u64 = u64::MAX;

impl WeldTable {
    fn reset(&mut self, vertices: usize) {
        // At most `Q_MAX` + 1 keys are ever inserted (`weld_vertex` refuses the mesh there), so the
        // table stops growing at twice that: a huge mesh that is certain to be refused costs no more.
        let cap = (vertices * 2).next_power_of_two().clamp(64, MAX_SLOTS);
        self.keys.clear();
        self.keys.resize(cap, EMPTY_KEY);
        if self.vals.len() < cap {
            self.vals.resize(cap, 0);
        }
        self.mask = cap - 1;
    }

    /// The value stored for `key`, inserting `next` when absent.
    #[inline]
    fn get_or_insert(&mut self, key: u64, next: u16) -> u16 {
        let mut i = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) as usize & self.mask;
        loop {
            let k = self.keys[i];
            if k == key {
                return self.vals[i];
            }
            if k == EMPTY_KEY {
                self.keys[i] = key;
                self.vals[i] = next;
                return next;
            }
            i = (i + 1) & self.mask;
        }
    }
}

impl Scratch {
    /// Slots the weld table currently holds.
    #[cfg(test)]
    pub(super) fn weld_slots(&self) -> usize {
        self.weld.keys.len()
    }

    fn begin(&mut self, vertices: usize) {
        self.weld.reset(vertices);
        self.nodes.clear();
        self.normal_sums.clear();
        self.remap.clear();
    }

    /// Weld source vertex `v` (lattice node `q`, side class `class`) and add its normal to the node's sum.
    #[inline]
    fn weld_vertex(&mut self, q: [u16; 3], class: u64, normal: &[f32]) -> Result<(), Refusal> {
        let key = q[0] as u64 | (q[1] as u64) << 16 | (q[2] as u64) << 32 | class << 48;
        // At most `Q_MAX` welded vertices (checked below), so `next` fits a u16.
        let next = self.nodes.len();
        let slot = self.weld.get_or_insert(key, next as u16);
        if slot as usize == next {
            if next == Q_MAX as usize {
                return Err(Refusal::WeldedVertices);
            }
            self.nodes.push(q);
            self.normal_sums.push([0.0; 3]);
        }
        let sum = &mut self.normal_sums[slot as usize];
        for axis in 0..3 {
            sum[axis] += normal[axis] as f64;
        }
        self.remap.push(slot);
        Ok(())
    }
}

/// Weld and quantize one mesh into `s` against `window` (lattice steps), or
/// the refusal. The caller checked that normals are per vertex.
pub(super) fn weld_mesh(mesh: &MeshDataJs, window: [i64; 3], step: f64, s: &mut Scratch) -> Result<(), Refusal> {
    s.begin(mesh.positions.len() / 3);
    s.tris.clear();
    let o = mesh.origin;
    let inv = 1.0 / step; // a power of two: exact
    for (p, n) in mesh.positions.chunks_exact(3).zip(mesh.normals.chunks_exact(3)) {
        let mut q = [0u16; 3];
        for axis in 0..3 {
            // The f64 `origin + position` is the frame coordinate, and it is rounded to its absolute
            // lattice node BEFORE the window is subtracted (in integers): a point shared by meshes with
            // different origins or windows lands on one node.
            let node = round_half_up((o[axis] + p[axis] as f64) * inv) as i64 - window[axis];
            // Defensive: `cell_window` admitted the bounds through this same expression.
            if !(0..=Q_MAX).contains(&node) {
                return Err(Refusal::Extent);
            }
            q[axis] = node as u16;
        }
        s.weld_vertex(q, 0, n)?;
    }
    split_unwitnessed_nodes(mesh, s)?;
    triangles(mesh, s)
}

/// Mark the welded vertices that have a corner their summed normal does not
/// witness. Returns whether there is one.
fn mark_unwitnessed(mesh: &MeshDataJs, s: &mut Scratch) -> bool {
    s.unwitnessed.clear();
    s.unwitnessed.resize(s.nodes.len(), false);
    let mut any = false;
    for (n, &slot) in mesh.normals.chunks_exact(3).zip(&s.remap) {
        let sum = s.normal_sums[slot as usize];
        let own = [n[0] as f64, n[1] as f64, n[2] as f64];
        let dot = sum[0] * own[0] + sum[1] * own[1] + sum[2] * own[2];
        let sum_sq = sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2];
        let own_sq = own[0] * own[0] + own[1] * own[1] + own[2] * own[2];
        // cos > MIN, without a square root per vertex. A corner without a normal has no side to witness.
        let witnessed = dot > 0.0 && dot * dot > MIN_WITNESS_COSINE * MIN_WITNESS_COSINE * sum_sq * own_sq;
        if own_sq > 0.0 && !witnessed {
            s.unwitnessed[slot as usize] = true;
            any = true;
        }
    }
    any
}

/// Dominant-axis class of a normal: 1..=6 (axis and sign).
#[inline]
fn side_class(n: &[f32]) -> u64 {
    let (ax, ay, az) = (n[0].abs(), n[1].abs(), n[2].abs());
    let axis = if ax >= ay && ax >= az { 0 } else if ay >= az { 1 } else { 2 };
    1 + (axis as u64) * 2 + u64::from(n[axis] < 0.0)
}

/// Keep corners that face opposite sides of a lattice node apart.
///
/// Where the two sides of a thin sheet (or a sharp fin) share positions, the
/// sum of their normals is near zero or on the wrong side for some face; the
/// shader's sign then is rounding noise and whole faces shade as back faces,
/// differently per GPU. Such a node is welded again per `side_class`, so each
/// part stores a normal on its own side. Only meshes that have such a node pay
/// the second pass; one that still has an unwitnessed corner after it is
/// refused and stays on the f32 path.
fn split_unwitnessed_nodes(mesh: &MeshDataJs, s: &mut Scratch) -> Result<(), Refusal> {
    if !mark_unwitnessed(mesh, s) {
        return Ok(());
    }
    std::mem::swap(&mut s.nodes, &mut s.first_nodes);
    std::mem::swap(&mut s.remap, &mut s.first_remap);
    s.begin(mesh.positions.len() / 3);
    for (v, n) in mesh.normals.chunks_exact(3).enumerate() {
        let first = s.first_remap[v] as usize;
        let class = if s.unwitnessed[first] { side_class(n) } else { 0 };
        s.weld_vertex(s.first_nodes[first], class, n)?;
    }
    if mark_unwitnessed(mesh, s) {
        return Err(Refusal::Normals);
    }
    Ok(())
}

/// Remap the triangles (dropping those with a repeated welded vertex), and
/// refuse a mesh the lattice collapses or crumples (#9068, #11444) or leaves
/// without a triangle.
fn triangles(mesh: &MeshDataJs, s: &mut Scratch) -> Result<(), Refusal> {
    let p = &mesh.positions;
    let (mut area, mut collapsed, mut turned) = (0.0f64, 0.0f64, 0.0f64);
    for t in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
        if a >= s.remap.len() || b >= s.remap.len() || c >= s.remap.len() {
            return Err(Refusal::IndexRange);
        }
        let corner = |i: usize, axis: usize| p[i * 3 + axis] as f64;
        let u = [corner(b, 0) - corner(a, 0), corner(b, 1) - corner(a, 1), corner(b, 2) - corner(a, 2)];
        let w = [corner(c, 0) - corner(a, 0), corner(c, 1) - corner(a, 1), corner(c, 2) - corner(a, 2)];
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        let tri_area = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let (ra, rb, rc) = (s.remap[a], s.remap[b], s.remap[c]);
        if tri_area > 0.0 {
            area += tri_area;
            match lattice_turn(&s.nodes, [ra, rb, rc], n, tri_area) {
                Turn::Collapsed => collapsed += tri_area,
                Turn::Turned => turned += tri_area,
                Turn::Kept => {}
            }
        }
        if ra != rb && rb != rc && ra != rc {
            s.tris.extend_from_slice(&[ra, rb, rc]);
        }
    }
    if collapsed > area * MAX_COLLAPSED_AREA_FRACTION {
        return Err(Refusal::Collapse);
    }
    if s.tris.is_empty() {
        return Err(Refusal::Empty);
    }
    // Counted under `Collapse` too: the lattice crumples it, and a finer level is the remedy.
    if turned > area * MAX_TURNED_AREA_FRACTION {
        return Err(Refusal::Collapse);
    }
    Ok(())
}

/// What a triangle's lattice nodes do to its face.
enum Turn {
    Kept,
    /// Flipped, or turned past `MIN_LATTICE_COS2` from the source face.
    Turned,
    /// Collinear: a zero integer cross product.
    Collapsed,
}

/// Triangle `a, b, c` on the lattice, against `source`, the source face's cross product, whose
/// length is `source_len`.
fn lattice_turn(nodes: &[[u16; 3]], [a, b, c]: [u16; 3], source: [f64; 3], source_len: f64) -> Turn {
    let (na, nb, nc) = (nodes[a as usize], nodes[b as usize], nodes[c as usize]);
    let d = |x: [u16; 3], y: [u16; 3], axis: usize| (x[axis] as i64 - y[axis] as i64) as f64;
    let u = [d(nb, na, 0), d(nb, na, 1), d(nb, na, 2)];
    let w = [d(nc, na, 0), d(nc, na, 1), d(nc, na, 2)];
    // Offsets are at most 65,535 steps, so the cross product is exact in f64 and a collapse is
    // exactly zero; the turn comparison itself is approximate.
    let q = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    let q_sq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
    if q_sq == 0.0 {
        return Turn::Collapsed;
    }
    let turn = source[0] * q[0] + source[1] * q[1] + source[2] * q[2];
    if turn <= 0.0 || turn * turn < MIN_LATTICE_COS2 * source_len * source_len * q_sq {
        return Turn::Turned;
    }
    Turn::Kept
}
