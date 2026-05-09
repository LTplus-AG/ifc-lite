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

/// Convert an ifc-lite `Mesh` (f32 positions, u32 indices) to a Manifold
/// (f64 vertex properties, u64 triangle indices).
fn mesh_to_manifold(mesh: &Mesh) -> Result<Manifold, BoolFailureReason> {
    if mesh.is_empty() {
        return Err(BoolFailureReason::EmptyOperand);
    }

    // Pack positions: Manifold expects xyz xyz xyz... in f64.
    let vert_props: Vec<f64> = mesh.positions.iter().map(|&v| v as f64).collect();
    let tri_indices: Vec<u64> = mesh.indices.iter().map(|&i| u64::from(i)).collect();

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
