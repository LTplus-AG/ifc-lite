// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Make a mesh's per-triangle winding consistent and OUTWARD, per connected
//! component.
//!
//! IFC faceted breps (whose face loops are not reliably outward) and merged
//! multi-item bodies (an extrusion unioned with a boolean cut) can arrive with
//! MIXED per-triangle winding: some faces wound outward, some inward. That
//! corrupts signed volume (quantities) and the smooth normals
//! [`crate::csg::calculate_normals`] accumulates from the winding (lighting). The
//! kernel's whole-operand `orient_outward` only flips an ENTIRE mesh by its
//! global signed volume, so it cannot repair a mesh that is internally
//! inconsistent.
//!
//! [`orient_mesh_outward`] recovers face adjacency (the meshes are flat-shaded,
//! so positions are welded by a fine grid), propagates a consistent orientation
//! across shared edges per connected component, then flips each CLOSED component
//! so its signed volume is positive (outward). An OPEN component (a TIN /
//! `SurfaceModel` sheet with boundary edges — no meaningful enclosed volume) or a
//! non-manifold / non-orientable one is left untouched: re-orienting it is
//! ambiguous and would reverse authored normals. The winding-invariant geometry
//! hash and the summary snapshots are unaffected; only normals/quantities change,
//! which is the point.
//!
//! Deciding all of that requires knowing, per connected component, whether it is
//! closed and whether it is orientable — and this pass is the ONLY place in the
//! pipeline that knows. [`orient_mesh_outward_verdict`] hands that verdict back
//! (it used to be computed and dropped on the floor); see [`OrientVerdict`].

use crate::Mesh;
use rustc_hash::FxHashMap;
use std::cell::RefCell;

/// Incident-triangle record for one undirected welded edge. A boundary edge has
/// one incident triangle and a manifold edge exactly two, so the two triangle
/// slots are stored INLINE — replacing the old per-edge heap `Vec<usize>`, which
/// allocated ~1.5 tiny Vecs per triangle and dominated the allocator churn of
/// this pass on mesh-heavy models. `count` is the TRUE incidence; a value > 2
/// marks a non-manifold edge, which the propagation skips before ever reading
/// the slots. Only the first two triangles are consulted, stored in ascending
/// scan order (identical to the old `Vec` push order), so the BFS traversal —
/// and therefore every flip decision — is byte-identical.
#[derive(Clone, Copy, Default)]
struct EdgeInc {
    tris: [usize; 2],
    count: u32,
}

impl EdgeInc {
    #[inline]
    fn push(&mut self, t: usize) {
        if (self.count as usize) < 2 {
            self.tris[self.count as usize] = t;
        }
        self.count += 1;
    }

    /// The incident triangles the propagation may consult (the first two, in
    /// push order). Only reached for `count` of 1 or 2 — the `count > 2` path
    /// `continue`s first — so this yields exactly what the old `Vec` iterated.
    #[inline]
    fn incident(&self) -> &[usize] {
        &self.tris[..(self.count as usize).min(2)]
    }
}

/// Vertex weld grid scale (reciprocal of a 10 µm grid, i.e. positions are
/// quantized to `round(v * WELD_SCALE)`): fine enough not to merge distinct
/// mm-scale features, coarse enough to weld the (usually bit-equal) coincident
/// flat-shaded duplicates so shared edges are found. Under-welding only splits
/// a body into more components (each still oriented); over-welding would fuse
/// distinct vertices and is the dangerous direction, so the grid stays fine.
const WELD_SCALE: f64 = 1.0e5;

/// Per-worker reusable scratch for [`orient_mesh_outward`], cleared (never freed)
/// between meshes. The pass runs once per assembled submesh (~109k times on a
/// mesh-heavy model), so each fresh call's two `FxHashMap`s + six `Vec`s were
/// ~4-6% of busy CPU on pure-brep/steel models; pooling makes it allocate-once,
/// clear-many. BYTE-IDENTICAL: neither map is ever iterated — both are only
/// `.entry()`-inserted (order fixed by the deterministic scan) and keyed-looked-up,
/// so bucket count / residual capacity can't reach the output; every `Vec` is
/// fully overwritten before it is read. A cleared, reused buffer replays the
/// identical fill sequence, so the flip decisions and `indices.swap`s are unchanged.
#[derive(Default)]
struct OrientScratch {
    vid_of: FxHashMap<(i64, i64, i64), u32>,
    vpos: Vec<[f64; 3]>,
    corner: Vec<u32>,
    edge_tris: FxHashMap<(u32, u32), EdgeInc>,
    flip: Vec<bool>,
    visited: Vec<bool>,
    comp: Vec<usize>,
    stack: Vec<usize>,
}

thread_local! {
    /// One scratch per rayon worker (and the main / wasm single thread). A
    /// `thread_local!`, not the `Vec<Mutex<_>>` worker-slot pattern: this LEAF
    /// buffer never crosses a crate boundary, needs no lock (so no deadlock risk,
    /// unlike the CartesianPoint cache #1572), and works when
    /// `rayon::current_thread_index()` is `None` (direct calls, tests, wasm). Each
    /// worker owns its instance — no cross-thread sharing, fully deterministic.
    /// Re-entrancy is TAKE / put-back (below): the `RefCell` borrow is never held
    /// across the computation, so a nested-`par_iter` re-entrant call on the same
    /// thread mints a fresh scratch instead of panicking on a double borrow.
    static ORIENT_SCRATCH: RefCell<Option<OrientScratch>> = const { RefCell::new(None) };
}

/// What [`orient_mesh_outward_verdict`] concluded about a mesh's SURFACE
/// TOPOLOGY, on top of whether it re-wound anything.
///
/// The orienter has to decide, per connected component, whether that component
/// is CLOSED (every welded edge shared by exactly two triangles) and ORIENTABLE
/// (no winding contradiction closes a cycle), because only such a component has
/// a meaningful "outward" to flip toward. It then discarded the answer. Nothing
/// downstream can recover it: by the time a mesh reaches the hasher or the FFI
/// boundary the adjacency has not been rebuilt, and rebuilding it is this pass's
/// whole cost.
///
/// The consumer that needs it is a divergence-theorem volume. Over an OPEN
/// surface that sum is not approximate, it is ARBITRARY — the boundary-loop flux
/// grows with the distance to the reference point, so the "volume" of a sheet is
/// whatever you referenced it to. There is no way to spot that from the number
/// itself; it looks like an ordinary positive volume. This verdict is what lets
/// a consumer refuse instead of guessing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct OrientVerdict {
    /// At least one triangle's winding was flipped, so any baked normals are
    /// stale. Exactly the `bool` [`orient_mesh_outward`] returns.
    pub flipped: bool,
    /// EVERY connected component is closed (no boundary edge, no non-manifold
    /// edge). False if there are no components at all — see [`Self::INDETERMINATE`].
    pub all_closed: bool,
    /// EVERY connected component is orientable (consistent winding propagated
    /// without contradiction). Independent of `all_closed`: a Klein-bottle-like
    /// or self-touching component can be edge-manifold yet non-orientable.
    pub all_orientable: bool,
    /// Connected components found (BFS over welded-edge adjacency). A single
    /// closed body is 1; a faceted brep holding two disjoint solids, or a solid
    /// plus the shell of its own cavity, is 2.
    pub components: u32,
}

impl OrientVerdict {
    /// The verdict for a mesh the orienter refused to analyse: fewer than two
    /// triangles, or a malformed position/index buffer. Nothing is known, so
    /// nothing is claimed — `all_closed` is FALSE rather than vacuously true, so
    /// a consumer gating on it emits nothing. That is also the correct geometric
    /// answer: a mesh of under two triangles cannot enclose anything.
    pub const INDETERMINATE: Self = Self {
        flipped: false,
        all_closed: false,
        all_orientable: false,
        components: 0,
    };

    /// The one shape for which a divergence-theorem volume over this mesh is
    /// trustworthy: EXACTLY ONE closed, orientable component.
    ///
    /// Why not the weaker "all components closed". This pass flips each closed
    /// component so its OWN signed volume is positive. For two disjoint solids
    /// that is right and the sum is their combined volume. But for a solid whose
    /// cavity is modelled as a second, inner shell it is wrong in the worst way:
    /// the cavity shell is also made positive, so the sum reports
    /// `outer + cavity` where the true volume is `outer − cavity`. Telling those
    /// two arrangements apart needs a containment test this pass does not do —
    /// and the orientation it already applied has destroyed the sign that would
    /// have distinguished them. One component has no such ambiguity.
    #[inline]
    pub fn is_single_closed_solid(&self) -> bool {
        self.components == 1 && self.all_closed && self.all_orientable
    }
}

/// Orient every connected component of `mesh` consistently and outward, in place.
/// Returns `true` iff any triangle's winding was flipped (the caller must then
/// recompute normals — the existing ones were baked with the old winding).
///
/// Thin wrapper over [`orient_mesh_outward_verdict`], kept because most callers
/// only ever needed the "did you touch my normals" bit.
pub fn orient_mesh_outward(mesh: &mut Mesh) -> bool {
    orient_mesh_outward_verdict(mesh).flipped
}

/// [`orient_mesh_outward`], also reporting the per-component topology it had to
/// work out along the way. See [`OrientVerdict`].
///
/// Identical mutation: this IS the orienting pass, and no flip decision reads
/// the verdict fields.
pub fn orient_mesh_outward_verdict(mesh: &mut Mesh) -> OrientVerdict {
    let ntri = mesh.indices.len() / 3;
    if ntri < 2 {
        return OrientVerdict::INDETERMINATE;
    }
    // Bail cleanly on malformed buffers instead of panicking on an out-of-range
    // index below. (Before any scratch is taken — the bail path allocates nothing.)
    let vertex_count = mesh.positions.len() / 3;
    if !mesh.positions.len().is_multiple_of(3)
        || mesh.indices.iter().any(|&idx| idx as usize >= vertex_count)
    {
        return OrientVerdict::INDETERMINATE;
    }

    // Take this worker's warm scratch (or mint one on the first call / a re-entrant
    // borrow). The momentary `.with` borrow is never held across the pass, so a
    // nested-`par_iter` re-entrant call on this thread can't trip a double borrow;
    // the scratch is handed back on the single return path (byte-for-byte the
    // pre-pool algorithm). The disjoint `&mut` field bindings (the borrow checker
    // splits struct fields) let a read-only closure borrow one buffer while another
    // is mutated.
    let mut scratch = ORIENT_SCRATCH.with(|c| c.borrow_mut().take()).unwrap_or_default();
    let OrientScratch { vid_of, vpos, corner, edge_tris, flip, visited, comp, stack } =
        &mut scratch;
    // Clear (retain capacity) before use so no stale data leaks in; the reserves
    // restore the original `with_capacity` sizing.
    vid_of.clear();
    vid_of.reserve(vertex_count);
    vpos.clear();
    corner.clear();
    corner.reserve(mesh.indices.len());

    // Weld positions -> welded vertex id; record the welded vid of every corner.
    let q = |v: f32| (v as f64 * WELD_SCALE).round() as i64;
    for &idx in &mesh.indices {
        let b = idx as usize * 3;
        let key = (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        );
        let vid = *vid_of.entry(key).or_insert_with(|| {
            let id = vpos.len() as u32;
            vpos.push([
                key.0 as f64 / WELD_SCALE,
                key.1 as f64 / WELD_SCALE,
                key.2 as f64 / WELD_SCALE,
            ]);
            id
        });
        corner.push(vid);
    }
    let tv = |t: usize| [corner[3 * t], corner[3 * t + 1], corner[3 * t + 2]];

    // Undirected welded edge -> incident triangles. >2 incident ⇒ non-manifold.
    // A closed manifold has ~1.5 edges per triangle; reserve to skip rehashing.
    edge_tris.clear();
    edge_tris.reserve(ntri * 2);
    for t in 0..ntri {
        let v = tv(t);
        for &(a, b) in &[(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
            if a == b {
                continue; // welded-degenerate edge
            }
            let key = if a < b { (a, b) } else { (b, a) };
            edge_tris.entry(key).or_default().push(t);
        }
    }

    // `clear()` + `resize(ntri, false)` reproduces the original `vec![false; ntri]`.
    flip.clear();
    flip.resize(ntri, false);
    visited.clear();
    visited.resize(ntri, false);
    let mut any_flip = false;
    // The verdict, folded across components as they are discovered. `all_*`
    // start TRUE because they are conjunctions over the components; a mesh with
    // zero components never reaches here (`ntri < 2` bailed above), so they can
    // never be reported vacuously true.
    let mut verdict = OrientVerdict {
        flipped: false,
        all_closed: true,
        all_orientable: true,
        components: 0,
    };

    for seed in 0..ntri {
        if visited[seed] {
            continue;
        }
        verdict.components += 1;
        // BFS the component, propagating a consistent orientation. `comp`/`stack`
        // are cleared per component (pre-pool freshly allocated them) — identical order.
        comp.clear();
        stack.clear();
        stack.push(seed);
        visited[seed] = true;
        let mut orientable = true;
        // Only a CLOSED manifold (every welded edge shared by exactly two tris) has
        // a meaningful "outward". An OPEN component — an `IfcTriangulatedFaceSet`
        // TIN (`Closed=.F.`), a `SurfaceModel` sheet — would be flipped by its
        // (meaningless) signed volume, reversing the authored normals. Track any
        // boundary/non-manifold edge and leave such a component untouched.
        let mut closed = true;

        while let Some(t) = stack.pop() {
            comp.push(t);
            let v = tv(t);
            // Effective directed edges of t given its current flip.
            let dirs = if flip[t] {
                [(v[0], v[2]), (v[2], v[1]), (v[1], v[0])]
            } else {
                [(v[0], v[1]), (v[1], v[2]), (v[2], v[0])]
            };
            for &(a, b) in &dirs {
                if a == b {
                    continue;
                }
                let key = if a < b { (a, b) } else { (b, a) };
                let inc = &edge_tris[&key];
                if inc.count != 2 {
                    closed = false; // boundary (1) or non-manifold (>2) edge
                }
                if inc.count > 2 {
                    continue; // ambiguous — don't propagate across a non-manifold edge
                }
                for &nb in inc.incident() {
                    if nb == t {
                        continue;
                    }
                    // A consistent neighbour must traverse this edge as (b, a). Its
                    // UNFLIPPED winding has (a, b) iff it must flip to do so.
                    let nv = tv(nb);
                    let need_flip =
                        [(nv[0], nv[1]), (nv[1], nv[2]), (nv[2], nv[0])].contains(&(a, b));
                    if !visited[nb] {
                        visited[nb] = true;
                        flip[nb] = need_flip;
                        stack.push(nb);
                    } else if flip[nb] != need_flip {
                        orientable = false; // contradiction (non-orientable)
                    }
                }
            }
        }

        verdict.all_closed &= closed;
        verdict.all_orientable &= orientable;

        if !orientable || !closed {
            for &t in comp.iter() {
                flip[t] = false; // open / non-orientable — leave winding as authored
            }
            continue;
        }

        // Flip the whole CLOSED component outward (positive signed volume).
        let mut vol6 = 0.0f64;
        for &t in comp.iter() {
            let v = tv(t);
            let (i0, i1, i2) = if flip[t] {
                (v[0], v[2], v[1])
            } else {
                (v[0], v[1], v[2])
            };
            let (a, b, c) = (vpos[i0 as usize], vpos[i1 as usize], vpos[i2 as usize]);
            vol6 += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]);
        }
        if vol6 < 0.0 {
            for &t in comp.iter() {
                flip[t] = !flip[t];
            }
        }
    }

    for t in 0..ntri {
        if flip[t] {
            mesh.indices.swap(3 * t + 1, 3 * t + 2);
            any_flip = true;
        }
    }
    verdict.flipped = any_flip;
    // Field borrows have ended (NLL); hand the now-warm scratch back to this worker.
    ORIENT_SCRATCH.with(|c| *c.borrow_mut() = Some(scratch));
    verdict
}

#[cfg(test)]
#[path = "mesh_orient_tests.rs"]
mod tests;
