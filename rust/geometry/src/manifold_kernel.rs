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
        let i0 = old_to_new[chunk[0] as usize];
        let i1 = old_to_new[chunk[1] as usize];
        let i2 = old_to_new[chunk[2] as usize];
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

/// Convert an ifc-lite `Mesh` (f32 positions, u32 indices) to a Manifold
/// (f64 vertex properties, u64 triangle indices). Runs a vertex-weld
/// pre-pass — see [`weld_vertices`] for why.
fn mesh_to_manifold(mesh: &Mesh) -> Result<Manifold, BoolFailureReason> {
    if mesh.is_empty() {
        return Err(BoolFailureReason::EmptyOperand);
    }

    let (vert_props, tri_indices, _dedup) = weld_vertices(mesh);
    if tri_indices.is_empty() {
        return Err(BoolFailureReason::DegenerateOperand);
    }

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
}
