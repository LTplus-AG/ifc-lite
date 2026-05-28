// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Manifold (https://github.com/elalish/manifold) CSG adapter.
//!
//! Replaces the legacy in-tree BSP port (`bsp_csg.rs`) with Google's
//! Manifold kernel for `subtract` / `union` / `intersection` on triangle
//! meshes. Removes the 24-polygon operand cap and produces
//! manifold-by-construction output.
//!
//! Gated behind the `manifold-csg` Cargo feature. While the migration is
//! in flight (Sprint 2 / T1.1) the legacy BSP remains the default path so
//! correctness and bundle-size budgets can be validated incrementally.
//!
//! Vertex normals are recomputed from positions after each operation:
//! Manifold tracks per-vertex properties separately and we don't yet
//! round-trip our normals through it.
//!
//! See `bsp_csg.rs` for the legacy alternative; the public surface here
//! mirrors its `union` / `difference` / `intersection` shapes via the
//! mesh-level wrappers in `csg.rs`.

use crate::csg::calculate_normals;
use crate::diagnostics::BoolFailureReason;
use crate::mesh::Mesh;
use manifold_csg::Manifold;
use rustc_hash::FxHashMap;

/// Spatial-quantization scale for vertex welding. Positions are bucketed
/// at micron resolution before hashing, so two f32 vertices closer than
/// ~5e-7 in absolute coordinates collapse to the same canonical index.
///
/// IFC dimensions are nominally in metres; 1 µm precision is well below
/// any meaningful BIM tolerance and below f32's 7-digit mantissa for
/// positions in the [-1000, 1000] m range we expect.
const WELD_QUANTIZATION: f32 = 1.0e6;

/// Quantize a position component for hashing.
#[inline]
fn quantize(v: f32) -> i64 {
    (v * WELD_QUANTIZATION).round() as i64
}

/// Vertex-weld pass: collapse positions that quantize to the same bucket
/// to a single canonical vertex, then re-index the triangle list. Drops
/// degenerate triangles (any two corners welded to the same vertex) on
/// the way out.
///
/// Necessary because ifc-lite's extruded-solid builder emits a fresh
/// vertex per face corner — every cube has 24 vertices instead of 8, and
/// the cap-vs-side-wall meshes don't share corners. Manifold's
/// `from_mesh_f64` checks adjacency via vertex-index identity and
/// rejects the input as `NotManifold` if shared edges have different
/// vertices on each side.
///
/// Returns `(welded_positions_packed, welded_tri_indices, dedup_count)`.
fn weld_vertices(mesh: &Mesh) -> (Vec<f64>, Vec<u64>, usize) {
    let n_verts = mesh.positions.len() / 3;
    if n_verts == 0 {
        return (Vec::new(), Vec::new(), 0);
    }

    let mut bucket_to_canonical: FxHashMap<(i64, i64, i64), u32> =
        FxHashMap::default();
    let mut old_to_new: Vec<u32> = Vec::with_capacity(n_verts);
    let mut welded_pos: Vec<f64> = Vec::with_capacity(n_verts * 3);

    for i in 0..n_verts {
        let x = mesh.positions[i * 3];
        let y = mesh.positions[i * 3 + 1];
        let z = mesh.positions[i * 3 + 2];
        let key = (quantize(x), quantize(y), quantize(z));
        let canonical = *bucket_to_canonical.entry(key).or_insert_with(|| {
            let idx = (welded_pos.len() / 3) as u32;
            welded_pos.push(x as f64);
            welded_pos.push(y as f64);
            welded_pos.push(z as f64);
            idx
        });
        old_to_new.push(canonical);
    }

    let dedup_count = n_verts.saturating_sub(welded_pos.len() / 3);

    let mut welded_tris: Vec<u64> = Vec::with_capacity(mesh.indices.len());
    for chunk in mesh.indices.chunks_exact(3) {
        let i0_raw = chunk[0] as usize;
        let i1_raw = chunk[1] as usize;
        let i2_raw = chunk[2] as usize;
        // Skip triangles whose indices point past the position array —
        // matches the legacy `mesh_to_polygons` bounds check, so a
        // malformed input mesh degrades to "fewer triangles" rather
        // than a panic that aborts the whole geometry processing pass.
        if i0_raw >= n_verts || i1_raw >= n_verts || i2_raw >= n_verts {
            continue;
        }
        let i0 = old_to_new[i0_raw];
        let i1 = old_to_new[i1_raw];
        let i2 = old_to_new[i2_raw];
        // Drop triangles that collapsed to a degenerate edge or point.
        if i0 == i1 || i1 == i2 || i0 == i2 {
            continue;
        }
        welded_tris.push(u64::from(i0));
        welded_tris.push(u64::from(i1));
        welded_tris.push(u64::from(i2));
    }

    (welded_pos, welded_tris, dedup_count)
}

/// Flood-fill triangle winding so every face's outward normal points
/// away from the solid interior.
///
/// **Why this exists.** IFC `IfcFacetedBrep` shells should ship with
/// outward-facing face normals, but plenty of exporters break that
/// invariant — flipped faces, mixed winding across a shell, globally
/// inverted shells — and Manifold's manifold-by-construction
/// assumption silently inverts inside/outside when the input violates
/// it. The empirical failure mode is the one this commit chain
/// chases: `host - cutter` returns the cutter mesh instead of the
/// cut host. Symptom in production: House.ifc wall #3448 rendering
/// as a triangular spike. The pre-Manifold BSP path clipped polygons
/// individually and tolerated mixed winding; Manifold doesn't.
///
/// **Algorithm.** Standard manifold-orientability flood-fill:
/// 1. Build an `(min_v, max_v) → [(tri, direction)]` edge index over
///    the welded triangle list.
/// 2. Cluster triangles into connected components via union-find over
///    shared edges. Each component (typically one per `IfcClosedShell`,
///    but an `IfcFacetedBrepWithVoids` ships one outer + N inner
///    shells) is oriented independently.
/// 3. Per component, pick a seed triangle that touches the vertex of
///    greatest extent along the component's longest axis. That vertex
///    is on the convex hull, so the seed's outward normal must have
///    a non-negative component along that axis. If the seed's normal
///    points the wrong way, flip the seed before propagating.
/// 4. BFS from the seed. For any two adjacent triangles, the shared
///    edge has to be traversed in OPPOSITE directions if both are
///    outward-facing. When the neighbour traverses the edge in the
///    SAME direction as the source, flip the neighbour
///    (`tri.swap(0, 2)` — preserves the third vertex, flips the
///    cycle).
///
/// Mutates `tris` in place. Positions are read-only.
fn reorient_outward(positions: &[f64], tris: &mut [u64]) {
    let n_verts = positions.len() / 3;
    let n_tris = tris.len() / 3;
    if n_verts == 0 || n_tris == 0 {
        return;
    }

    // ── 1. Edge → [(tri_idx, traversed_low_to_high)] index ─────────────
    // Direction = true if the triangle traverses the edge from the
    // lower-indexed vertex to the higher-indexed vertex.
    let mut edge_map: FxHashMap<(u32, u32), smallvec::SmallVec<[(u32, bool); 4]>> =
        FxHashMap::default();
    edge_map.reserve(n_tris * 3);

    for t_idx in 0..n_tris {
        let t = &tris[t_idx * 3..t_idx * 3 + 3];
        for k in 0..3 {
            let a = t[k] as u32;
            let b = t[(k + 1) % 3] as u32;
            let key = if a < b { (a, b) } else { (b, a) };
            let low_to_high = a < b;
            edge_map.entry(key).or_default().push((t_idx as u32, low_to_high));
        }
    }

    // ── 2. Union-find for connected components ──────────────────────────
    let mut parent: Vec<u32> = (0..n_tris as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            let p = parent[x as usize];
            parent[x as usize] = parent[p as usize]; // path compression
            x = parent[x as usize];
        }
        x
    }
    fn union(parent: &mut [u32], a: u32, b: u32) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent[ra as usize] = rb;
        }
    }
    for entries in edge_map.values() {
        // Only honour 2-triangle (manifold) edges. Non-manifold edges
        // (T-junctions, fold-overs) don't define a consistent
        // neighbour relation — leave such triangles in their own
        // component rather than risk a wrong-direction flip.
        if entries.len() != 2 {
            continue;
        }
        union(&mut parent, entries[0].0, entries[1].0);
    }
    let mut components: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for t in 0..n_tris as u32 {
        let root = find(&mut parent, t);
        components.entry(root).or_default().push(t);
    }

    // ── 3. Per-component BFS propagate (fixes mixed winding) ──────────
    //
    // For each component, pick an arbitrary seed and propagate
    // orientation across manifold (2-triangle) edges. Adjacent
    // triangles must traverse their shared edge in OPPOSITE
    // directions; when they don't, flip the neighbour. After this pass
    // every component is INTERNALLY consistent — all triangles in the
    // component face the same way (in or out).
    //
    // BFS only modifies the input when triangles are inconsistent
    // *within* a component. Well-formed shells have no inconsistencies
    // here, so the pass is a no-op on the common case.
    let mut visited = vec![false; n_tris];
    for component in components.values() {
        if component.is_empty() {
            continue;
        }
        let seed = component[0];
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(seed);
        visited[seed as usize] = true;
        while let Some(curr) = queue.pop_front() {
            let curr_tri = [
                tris[curr as usize * 3] as u32,
                tris[curr as usize * 3 + 1] as u32,
                tris[curr as usize * 3 + 2] as u32,
            ];
            for k in 0..3 {
                let a = curr_tri[k];
                let b = curr_tri[(k + 1) % 3];
                let key = if a < b { (a, b) } else { (b, a) };
                let curr_dir = a < b;
                let Some(adjs) = edge_map.get(&key) else {
                    continue;
                };
                if adjs.len() != 2 {
                    continue;
                }
                for &(other_idx, _other_dir) in adjs {
                    if other_idx == curr || visited[other_idx as usize] {
                        continue;
                    }
                    visited[other_idx as usize] = true;
                    let ot = [
                        tris[other_idx as usize * 3] as u32,
                        tris[other_idx as usize * 3 + 1] as u32,
                        tris[other_idx as usize * 3 + 2] as u32,
                    ];
                    let mut neighbour_dir = None;
                    for j in 0..3 {
                        let oa = ot[j];
                        let ob = ot[(j + 1) % 3];
                        if (oa.min(ob), oa.max(ob)) == key {
                            neighbour_dir = Some(oa < ob);
                            break;
                        }
                    }
                    let Some(neighbour_dir) = neighbour_dir else {
                        continue;
                    };
                    if neighbour_dir == curr_dir {
                        let base = other_idx as usize * 3;
                        tris.swap(base, base + 2);
                    }
                    queue.push_back(other_idx);
                }
            }
        }
    }

    // ── 4. Global signed-volume check ─────────────────────────────────
    //
    // Signed volume by the divergence theorem is positive for a
    // closed shell whose face normals point outward, negative for
    // inward. We deliberately compute this over the WHOLE input rather
    // than per-component because non-manifold edges (T-junctions in
    // exported FacetedBreps — observed at 24 such edges on FZK-Haus's
    // curved windows) split a single closed shell into multiple
    // pseudo-components. A subset of triangles has no inherent
    // "outward" direction — its signed-volume sign is just a function
    // of where its centroid sits relative to the origin, not of its
    // winding. Per-component flips on such subsets incorrectly invert
    // already-correct triangles.
    //
    // The whole-mesh sign is meaningful as long as the union of all
    // components forms a closed surface (which it does for any IFC
    // brep that gets to this point). If the global sign is negative,
    // every component was consistently inward — flip everything.
    let total_volume = signed_volume_6x(positions, tris);
    if total_volume < 0.0 {
        for t_idx in 0..n_tris {
            let base = t_idx * 3;
            tris.swap(base, base + 2);
        }
    }
}

/// Six times the signed tetrahedral volume of a triangle with the
/// origin — Σ over all triangles gives 6× the closed-shell volume by
/// the divergence theorem. Positive for outward-CCW closed shells,
/// negative for inward.
#[inline]
fn signed_volume_of(positions: &[f64], tris: &[u64], t_idx: usize) -> f64 {
    let base = t_idx * 3;
    let a = &positions[tris[base] as usize * 3..tris[base] as usize * 3 + 3];
    let b = &positions[tris[base + 1] as usize * 3..tris[base + 1] as usize * 3 + 3];
    let c = &positions[tris[base + 2] as usize * 3..tris[base + 2] as usize * 3 + 3];
    let cross_x = b[1] * c[2] - b[2] * c[1];
    let cross_y = b[2] * c[0] - b[0] * c[2];
    let cross_z = b[0] * c[1] - b[1] * c[0];
    a[0] * cross_x + a[1] * cross_y + a[2] * cross_z
}

#[inline]
fn signed_volume_6x(positions: &[f64], tris: &[u64]) -> f64 {
    let mut sum = 0.0;
    let n_tris = tris.len() / 3;
    for t in 0..n_tris {
        sum += signed_volume_of(positions, tris, t);
    }
    sum
}

/// Component of the triangle's geometric normal along `axis`.
/// Sign tells us which side of the plane the triangle's CCW winding
/// faces. Magnitude is unnormalised — callers only compare signs, so
/// the sqrt for normalisation is wasted work. Test-only after the
/// `reorient_outward` rewrite swapped local-axis seed selection for a
/// global signed-volume check.
#[cfg(test)]
fn triangle_normal_axis(positions: &[f64], tri: &[u64], axis: usize) -> f64 {
    let a = &positions[tri[0] as usize * 3..tri[0] as usize * 3 + 3];
    let b = &positions[tri[1] as usize * 3..tri[1] as usize * 3 + 3];
    let c = &positions[tri[2] as usize * 3..tri[2] as usize * 3 + 3];
    // (b - a) × (c - a)
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    let uz = b[2] - a[2];
    let vx = c[0] - a[0];
    let vy = c[1] - a[1];
    let vz = c[2] - a[2];
    match axis {
        0 => uy * vz - uz * vy,
        1 => uz * vx - ux * vz,
        _ => ux * vy - uy * vx,
    }
}

/// Convert an ifc-lite `Mesh` (f32 positions, u32 indices) to a Manifold
/// (f64 vertex properties, u64 triangle indices). Runs a vertex-weld
/// pre-pass — see [`weld_vertices`] for why — followed by a winding
/// flood-fill so every shell's face normals point outward — see
/// [`reorient_outward`] for the rationale (House.ifc gable wall).
fn mesh_to_manifold(mesh: &Mesh) -> Result<Manifold, BoolFailureReason> {
    if mesh.is_empty() {
        return Err(BoolFailureReason::EmptyOperand);
    }

    let (vert_props, mut tri_indices, _dedup) = weld_vertices(mesh);
    if tri_indices.is_empty() {
        return Err(BoolFailureReason::DegenerateOperand);
    }

    reorient_outward(&vert_props, &mut tri_indices);

    Manifold::from_mesh_f64(&vert_props, 3, &tri_indices)
        .map_err(|e| BoolFailureReason::KernelError(format!("mesh_to_manifold: {e}")))
}

/// Convert a Manifold result back to an ifc-lite `Mesh`. Vertex normals
/// are recomputed from positions; Manifold does not preserve our normals
/// through boolean operations.
fn manifold_to_mesh(m: &Manifold) -> Mesh {
    let (vert_props, n_props, tri_indices) = m.to_mesh_f64();
    if n_props < 3 || vert_props.is_empty() || tri_indices.is_empty() {
        return Mesh::new();
    }

    let n_verts = vert_props.len() / n_props;
    let mut mesh = Mesh::with_capacity(n_verts, tri_indices.len());

    // Strip extra vertex properties — only xyz position is meaningful for us.
    mesh.positions.reserve(n_verts * 3);
    for i in 0..n_verts {
        let base = i * n_props;
        mesh.positions.push(vert_props[base] as f32);
        mesh.positions.push(vert_props[base + 1] as f32);
        mesh.positions.push(vert_props[base + 2] as f32);
    }
    mesh.normals.resize(n_verts * 3, 0.0);

    mesh.indices.reserve(tri_indices.len());
    for &i in &tri_indices {
        mesh.indices.push(i as u32);
    }

    calculate_normals(&mut mesh);
    mesh
}

/// Manifold-backed boolean difference (`host - void`).
pub fn difference(host: &Mesh, void: &Mesh) -> Result<Mesh, BoolFailureReason> {
    let host_m = mesh_to_manifold(host)?;
    let void_m = mesh_to_manifold(void)?;
    let result = host_m.difference(&void_m);
    Ok(manifold_to_mesh(&result))
}

/// Manifold-backed boolean union (`a ∪ b`).
pub fn union(a: &Mesh, b: &Mesh) -> Result<Mesh, BoolFailureReason> {
    let a_m = mesh_to_manifold(a)?;
    let b_m = mesh_to_manifold(b)?;
    let result = a_m.union(&b_m);
    Ok(manifold_to_mesh(&result))
}

/// Manifold-backed boolean intersection (`a ∩ b`).
pub fn intersection(a: &Mesh, b: &Mesh) -> Result<Mesh, BoolFailureReason> {
    let a_m = mesh_to_manifold(a)?;
    let b_m = mesh_to_manifold(b)?;
    let result = a_m.intersection(&b_m);
    Ok(manifold_to_mesh(&result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::{Point3, Vector3};

    /// Unit box centred on `origin`, axis-aligned.
    fn unit_box_at(origin: Point3<f64>) -> Mesh {
        let mut m = Mesh::with_capacity(8, 36);
        let n = Vector3::new(0.0, 0.0, 0.0);
        let v = |dx: f64, dy: f64, dz: f64| {
            Point3::new(origin.x + dx, origin.y + dy, origin.z + dz)
        };
        let p = [
            v(0.0, 0.0, 0.0),
            v(1.0, 0.0, 0.0),
            v(1.0, 1.0, 0.0),
            v(0.0, 1.0, 0.0),
            v(0.0, 0.0, 1.0),
            v(1.0, 0.0, 1.0),
            v(1.0, 1.0, 1.0),
            v(0.0, 1.0, 1.0),
        ];
        for pt in &p {
            m.add_vertex(*pt, n);
        }
        let faces: [[u32; 6]; 6] = [
            [0, 2, 1, 0, 3, 2],
            [4, 5, 6, 4, 6, 7],
            [0, 4, 7, 0, 7, 3],
            [1, 2, 6, 1, 6, 5],
            [0, 1, 5, 0, 5, 4],
            [3, 7, 6, 3, 6, 2],
        ];
        for face in &faces {
            m.add_triangle(face[0], face[1], face[2]);
            m.add_triangle(face[3], face[4], face[5]);
        }
        m
    }

    /// Build a "polygon soup" cube: 6 quads each emitting 4 fresh vertices,
    /// like the extruded-solid builder produces. 24 vertices, 12 triangles.
    fn polygon_soup_cube() -> Mesh {
        let mut m = Mesh::new();
        let n = Vector3::new(0.0, 0.0, 0.0);
        let face = |verts: &[(f64, f64, f64); 4], mesh: &mut Mesh| {
            let base = mesh.vertex_count() as u32;
            for &(x, y, z) in verts {
                mesh.add_vertex(Point3::new(x, y, z), n);
            }
            mesh.add_triangle(base, base + 1, base + 2);
            mesh.add_triangle(base, base + 2, base + 3);
        };
        // -Z face
        face(&[(0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 1.0, 0.0), (1.0, 0.0, 0.0)], &mut m);
        // +Z face
        face(&[(0.0, 0.0, 1.0), (1.0, 0.0, 1.0), (1.0, 1.0, 1.0), (0.0, 1.0, 1.0)], &mut m);
        // -X face
        face(&[(0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, 1.0, 1.0), (0.0, 1.0, 0.0)], &mut m);
        // +X face
        face(&[(1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (1.0, 1.0, 1.0), (1.0, 0.0, 1.0)], &mut m);
        // -Y face
        face(&[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 0.0, 1.0), (0.0, 0.0, 1.0)], &mut m);
        // +Y face
        face(&[(0.0, 1.0, 0.0), (0.0, 1.0, 1.0), (1.0, 1.0, 1.0), (1.0, 1.0, 0.0)], &mut m);
        m
    }

    #[test]
    fn weld_collapses_polygon_soup_corners() {
        let soup = polygon_soup_cube();
        assert_eq!(soup.vertex_count(), 24);
        assert_eq!(soup.triangle_count(), 12);

        let (verts, tris, dedup) = weld_vertices(&soup);
        assert_eq!(verts.len() / 3, 8, "cube has 8 unique corners");
        assert_eq!(tris.len() / 3, 12, "no degenerate triangles after weld");
        assert_eq!(dedup, 16, "24 raw verts - 8 canonical = 16 deduped");
    }

    #[test]
    fn weld_drops_degenerate_triangles() {
        // Three vertices all at the same point - quantizes to one bucket,
        // triangle collapses to a point.
        let mut m = Mesh::new();
        let n = Vector3::new(0.0, 0.0, 0.0);
        m.add_vertex(Point3::new(1.0, 2.0, 3.0), n);
        m.add_vertex(Point3::new(1.0, 2.0, 3.0), n);
        m.add_vertex(Point3::new(1.0, 2.0, 3.0), n);
        m.add_triangle(0, 1, 2);

        let (verts, tris, _) = weld_vertices(&m);
        assert_eq!(verts.len() / 3, 1);
        assert!(tris.is_empty(), "collapsed triangle must be dropped");
    }

    #[test]
    fn weld_skips_out_of_range_triangle_index() {
        // A malformed mesh with a triangle index past the end of `positions`
        // must not panic. Pre-fix, `weld_vertices` indexed `old_to_new`
        // unchecked and aborted the whole geometry pass with an out-of-bounds
        // panic; the legacy `mesh_to_polygons` path bounds-checked and just
        // skipped the bad triangle. Match that behaviour so a single bad
        // triangle degrades to "fewer triangles" instead of a hard fault.
        let mut m = Mesh::new();
        let n = Vector3::new(0.0, 0.0, 0.0);
        // Three good vertices.
        m.add_vertex(Point3::new(0.0, 0.0, 0.0), n);
        m.add_vertex(Point3::new(1.0, 0.0, 0.0), n);
        m.add_vertex(Point3::new(0.0, 1.0, 0.0), n);
        m.add_triangle(0, 1, 2);
        // A triangle that references a non-existent fourth vertex.
        m.indices.extend_from_slice(&[0, 1, 99]);

        let (verts, tris, _) = weld_vertices(&m);
        assert_eq!(verts.len() / 3, 3);
        assert_eq!(tris.len() / 3, 1, "only the in-range triangle survives");

        // And the public path should not panic — it should either succeed
        // or return a structured failure.
        let _ = mesh_to_manifold(&m);
    }

    #[test]
    fn weld_makes_polygon_soup_manifold() {
        // Pre-T1.1.1 the polygon-soup cube is rejected by Manifold with
        // NotManifold (vertex identity per face). Post-weld it must round-trip.
        let soup = polygon_soup_cube();
        let m = mesh_to_manifold(&soup).expect("polygon-soup cube must be welded into a manifold");
        let back = manifold_to_mesh(&m);
        assert!(!back.is_empty());
        assert!(back.triangle_count() >= 12);
    }

    #[test]
    fn round_trip_preserves_solid() {
        let cube = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let manifold = mesh_to_manifold(&cube).expect("box -> manifold");
        let back = manifold_to_mesh(&manifold);
        assert!(!back.is_empty(), "round-trip mesh empty");
        assert!(back.triangle_count() >= 12, "cube must remain 12+ tri");
    }

    #[test]
    fn difference_cuts_a_hole() {
        // Big box - smaller box that pokes through one face.
        let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let cutter = unit_box_at(Point3::new(0.25, 0.25, -0.5));

        let result = difference(&host, &cutter).expect("difference ok");
        assert!(!result.is_empty(), "difference produced empty mesh");
        // Cutting through one face should add boundary triangles.
        assert!(
            result.triangle_count() > host.triangle_count(),
            "expected difference to create new boundary triangles, got {}",
            result.triangle_count()
        );
    }

    #[test]
    fn union_removes_overlap() {
        // Two overlapping boxes — union should produce manifold output
        // with fewer total triangles than naive concatenation (24).
        let a = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let b = unit_box_at(Point3::new(0.5, 0.0, 0.0));

        let result = union(&a, &b).expect("union ok");
        assert!(!result.is_empty());
        assert!(
            result.triangle_count() > 12,
            "union of two overlapping boxes must add boundary triangles"
        );
    }

    #[test]
    fn intersection_returns_overlap_volume() {
        let a = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let b = unit_box_at(Point3::new(0.5, 0.0, 0.0));

        let result = intersection(&a, &b).expect("intersection ok");
        assert!(!result.is_empty(), "intersection of overlapping boxes must be non-empty");
    }

    #[test]
    fn empty_operand_reports_failure() {
        let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let void = Mesh::new();
        let err = difference(&host, &void).unwrap_err();
        assert!(matches!(err, BoolFailureReason::EmptyOperand));
    }

    #[test]
    fn no_operand_size_cap() {
        // 5 boxes merged = 60 triangles, which busts the legacy
        // MAX_CSG_POLYGONS_PER_MESH = 24 cap. With Manifold this must succeed.
        let mut host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        for i in 1..5 {
            host.merge(&unit_box_at(Point3::new(i as f64 * 0.1, 0.0, 0.0)));
        }
        assert_eq!(host.triangle_count(), 60);
        let cutter = unit_box_at(Point3::new(0.05, 0.05, -0.5));
        let result = difference(&host, &cutter).expect("difference ok past 24-poly cap");
        assert!(!result.is_empty());
    }

    /// Build a unit box whose triangle winding is FLIPPED — every face
    /// CCW becomes CW. With outward normals expected, every face now
    /// points INWARD. Pre-fix this is exactly the input that made
    /// Manifold return the cutter mesh instead of the cut host on the
    /// House.ifc gable wall.
    fn unit_box_inside_out_at(origin: Point3<f64>) -> Mesh {
        let mut m = unit_box_at(origin);
        for tri in m.indices.chunks_exact_mut(3) {
            tri.swap(0, 2);
        }
        m
    }

    /// Build a unit box where the −X and +Y faces are correctly oriented
    /// but the other four are flipped — mixed winding across the shell,
    /// mimicking an IFC exporter that gets some face normals right and
    /// others wrong. Pre-fix this also confuses Manifold.
    fn unit_box_mixed_winding_at(origin: Point3<f64>) -> Mesh {
        let mut m = unit_box_at(origin);
        // unit_box_at lays the 12 triangles out 2-per-face in this order:
        // -Z, +Z, -X, +X, -Y, +Y. Keep -X (4, 5) and +Y (10, 11) sane;
        // flip the others.
        for face in [0, 1, 3, 4] {
            let base = face * 2;
            for tri in &mut [base, base + 1] {
                let t = *tri;
                m.indices.swap(t * 3, t * 3 + 2);
            }
        }
        m
    }

    #[test]
    fn reorient_outward_fixes_inside_out_box() {
        let bad = unit_box_inside_out_at(Point3::new(0.0, 0.0, 0.0));
        let (verts, mut tris, _) = weld_vertices(&bad);
        reorient_outward(&verts, &mut tris);

        // After reorientation, the average outward normal at the +Z face
        // must point in +Z. Cross-check: the top face has at least one
        // triangle whose normal axis-Z component is positive.
        let mut any_positive_top_normal = false;
        for chunk in tris.chunks_exact(3) {
            // A triangle on the top face has all three vertices at z ≈ 1.
            let on_top = chunk.iter().all(|&i| {
                let z = verts[i as usize * 3 + 2];
                (z - 1.0).abs() < 1e-6
            });
            if !on_top {
                continue;
            }
            if triangle_normal_axis(&verts, chunk, 2) > 0.0 {
                any_positive_top_normal = true;
                break;
            }
        }
        assert!(
            any_positive_top_normal,
            "after reorient, the +Z face must have an outward-facing triangle"
        );
    }

    #[test]
    fn difference_survives_inside_out_cutter() {
        // The canonical House.ifc bug. host is a correctly-oriented box;
        // the cutter is an inside-out box that pokes through one face.
        // Without the reorient pass, Manifold returns the cutter mesh
        // and the result lies partially outside the host bbox.
        let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let bad_cutter = unit_box_inside_out_at(Point3::new(0.25, 0.25, -0.5));
        let good_cutter = unit_box_at(Point3::new(0.25, 0.25, -0.5));

        let bad_result = difference(&host, &bad_cutter).expect("difference ok");
        let good_result = difference(&host, &good_cutter).expect("difference ok");

        // The two results should be structurally identical: same triangle
        // count, same bounding box. The reorient pass normalises the bad
        // cutter into the same shape as the good one before Manifold
        // ever sees the difference.
        assert_eq!(
            bad_result.triangle_count(),
            good_result.triangle_count(),
            "reorient-fixed cutter must produce the same triangle count as a correctly-oriented one",
        );
        let (bad_min, bad_max) = bad_result.bounds();
        let (good_min, good_max) = good_result.bounds();
        assert!((bad_min - good_min).abs().max() < 1e-5);
        assert!((bad_max - good_max).abs().max() < 1e-5);
    }

    #[test]
    fn difference_survives_mixed_winding_cutter() {
        // Four of six faces flipped — mimics a real-world IfcFacetedBrep
        // with per-face winding bugs (not just a globally-inverted shell).
        let host = unit_box_at(Point3::new(0.0, 0.0, 0.0));
        let mixed_cutter = unit_box_mixed_winding_at(Point3::new(0.25, 0.25, -0.5));
        let good_cutter = unit_box_at(Point3::new(0.25, 0.25, -0.5));

        let mixed_result = difference(&host, &mixed_cutter).expect("difference ok");
        let good_result = difference(&host, &good_cutter).expect("difference ok");

        assert_eq!(
            mixed_result.triangle_count(),
            good_result.triangle_count(),
            "reorient must reconcile mixed-winding cutter to outward-facing",
        );
    }
}
