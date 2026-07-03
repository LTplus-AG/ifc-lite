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

use crate::Mesh;
use rustc_hash::FxHashMap;

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

/// Vertex weld grid (10 µm): fine enough not to merge distinct mm-scale features,
/// coarse enough to weld the (usually bit-equal) coincident flat-shaded
/// duplicates so shared edges are found. Under-welding only splits a body into
/// more components (each still oriented); over-welding would fuse distinct
/// vertices and is the dangerous direction, so the grid stays fine.
const WELD: f64 = 1.0e5;

/// Orient every connected component of `mesh` consistently and outward, in place.
/// Returns `true` iff any triangle's winding was flipped (the caller must then
/// recompute normals — the existing ones were baked with the old winding).
pub fn orient_mesh_outward(mesh: &mut Mesh) -> bool {
    let ntri = mesh.indices.len() / 3;
    if ntri < 2 {
        return false;
    }
    // Bail cleanly on malformed buffers instead of panicking on an out-of-range
    // index below.
    let vertex_count = mesh.positions.len() / 3;
    if !mesh.positions.len().is_multiple_of(3)
        || mesh.indices.iter().any(|&idx| idx as usize >= vertex_count)
    {
        return false;
    }

    // Weld positions -> welded vertex id; record the welded vid of every corner.
    let q = |v: f32| (v as f64 * WELD).round() as i64;
    let mut vid_of: FxHashMap<(i64, i64, i64), u32> =
        FxHashMap::with_capacity_and_hasher(vertex_count, Default::default());
    let mut vpos: Vec<[f64; 3]> = Vec::new();
    let mut corner: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for &idx in &mesh.indices {
        let b = idx as usize * 3;
        let key = (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        );
        let vid = *vid_of.entry(key).or_insert_with(|| {
            let id = vpos.len() as u32;
            vpos.push([key.0 as f64 / WELD, key.1 as f64 / WELD, key.2 as f64 / WELD]);
            id
        });
        corner.push(vid);
    }
    let tv = |t: usize| [corner[3 * t], corner[3 * t + 1], corner[3 * t + 2]];

    // Undirected welded edge -> incident triangles. >2 incident ⇒ non-manifold.
    // A closed manifold has ~1.5 edges per triangle; reserve to skip rehashing.
    let mut edge_tris: FxHashMap<(u32, u32), EdgeInc> =
        FxHashMap::with_capacity_and_hasher(ntri * 2, Default::default());
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

    let mut flip = vec![false; ntri];
    let mut visited = vec![false; ntri];
    let mut any_flip = false;

    for seed in 0..ntri {
        if visited[seed] {
            continue;
        }
        // BFS the component, propagating a consistent orientation.
        let mut comp: Vec<usize> = Vec::new();
        let mut stack = vec![seed];
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

        if !orientable || !closed {
            for &t in &comp {
                flip[t] = false; // open / non-orientable — leave winding as authored
            }
            continue;
        }

        // Flip the whole CLOSED component outward (positive signed volume).
        let mut vol6 = 0.0f64;
        for &t in &comp {
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
            for &t in &comp {
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
    any_flip
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a unit cube as a flat-shaded mesh (positions not index-shared), with
    /// `bad` triangle indices given as flipped (inward) so the winding is mixed.
    fn cube(flipped: &[usize]) -> Mesh {
        // 12 triangles, outward-wound.
        let c = [
            [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
        ];
        let faces: [[usize; 3]; 12] = [
            [0, 2, 1], [0, 3, 2], // bottom z=0 (outward -z)
            [4, 5, 6], [4, 6, 7], // top z=1 (outward +z)
            [0, 1, 5], [0, 5, 4], // front y=0
            [2, 3, 7], [2, 7, 6], // back y=1
            [1, 2, 6], [1, 6, 5], // right x=1
            [0, 4, 7], [0, 7, 3], // left x=0
        ];
        let mut m = Mesh::new();
        for (t, f) in faces.iter().enumerate() {
            let mut tri = *f;
            if flipped.contains(&t) {
                tri.swap(1, 2);
            }
            for &vi in &tri {
                m.positions.extend_from_slice(&c[vi]);
                m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
            }
            let base = (m.indices.len()) as u32;
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        m
    }

    fn bad_edges(m: &Mesh) -> usize {
        let q = |v: f32| (v as f64 * WELD).round() as i64;
        let key = |i: u32| {
            let b = i as usize * 3;
            (q(m.positions[b]), q(m.positions[b + 1]), q(m.positions[b + 2]))
        };
        let mut dir: FxHashMap<((i64, i64, i64), (i64, i64, i64)), u32> = FxHashMap::default();
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (key(t[0]), key(t[1]), key(t[2]));
            for e in [(a, b), (b, c), (c, a)] {
                *dir.entry(e).or_insert(0) += 1;
            }
        }
        dir.values().filter(|&&c| c >= 2).count()
    }

    #[test]
    fn fixes_mixed_winding_to_consistent_outward() {
        let mut m = cube(&[3, 7, 10]); // three inward-flipped faces
        assert!(bad_edges(&m) > 0, "fixture must start winding-inconsistent");
        let flipped = orient_mesh_outward(&mut m);
        assert!(flipped, "the mixed-winding cube must be re-oriented");
        assert_eq!(bad_edges(&m), 0, "winding must be consistent after orient");
    }

    #[test]
    fn already_outward_is_untouched() {
        let mut m = cube(&[]);
        let before = m.indices.clone();
        let flipped = orient_mesh_outward(&mut m);
        assert!(!flipped, "a clean outward cube must not be touched");
        assert_eq!(m.indices, before, "index buffer must be byte-identical");
    }

    #[test]
    fn fully_inward_cube_is_flipped_outward() {
        // Every face inward: globally consistent but negative volume → flip all.
        let all: Vec<usize> = (0..12).collect();
        let mut m = cube(&all);
        assert_eq!(bad_edges(&m), 0, "a fully-inward cube is still consistent");
        let flipped = orient_mesh_outward(&mut m);
        assert!(flipped, "an inward-wound cube must be flipped outward");
        assert_eq!(bad_edges(&m), 0);
    }

    /// An OPEN sheet (a flat quad = two tris, with boundary edges) has no
    /// meaningful enclosed volume. Even with one tri authored backwards, the
    /// orienter must leave it byte-identical rather than flip it by a bogus
    /// signed volume (which would reverse a TIN / SurfaceModel's authored normals).
    #[test]
    fn open_sheet_is_left_untouched() {
        let p = [
            [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
        ];
        let faces: [[usize; 3]; 2] = [[0, 1, 2], [0, 3, 2]]; // tri 1 deliberately reversed
        let mut m = Mesh::new();
        for f in &faces {
            for &vi in f {
                m.positions.extend_from_slice(&p[vi]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            let base = m.indices.len() as u32;
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        let before = m.indices.clone();
        let flipped = orient_mesh_outward(&mut m);
        assert!(!flipped, "an open sheet must not be re-oriented");
        assert_eq!(m.indices, before, "open-sheet index buffer must be untouched");
    }

    /// Malformed buffers (an index past the vertex array) must bail cleanly, not
    /// panic.
    #[test]
    fn malformed_indices_bail_without_panic() {
        let mut m = cube(&[]);
        m.indices[0] = 9999; // out of range
        let flipped = orient_mesh_outward(&mut m);
        assert!(!flipped, "malformed input must be a no-op");
    }
}
