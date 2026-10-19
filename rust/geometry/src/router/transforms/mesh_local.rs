// SPDX-License-Identifier: MPL-2.0
//! Canonical decoder-free mapped-frame transforms.
use crate::{Mesh, Point3, Vector3};
use nalgebra::Matrix4;
use super::mesh_world::LARGE_MAPPED_ORIGIN_M;

/// Canonical decoder-free mapped-frame transform, shared by owned operations
/// and the borrowed router compatibility adapter.
pub(crate) fn transform_mesh_local(mesh: &mut Mesh, transform: &Matrix4<f64>) {
    // Published object-frame bounds (set on RTC-rebased items, #5698)
    // must follow the geometry into the mapped frame: the enclosing box
    // of the transformed corners, rounded outward to f32.
    if let Some(bounds) = mesh.local_bounds {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for corner in 0..8 {
            let pick = |axis: usize| bounds[axis + 3 * ((corner >> axis) & 1)] as f64;
            let t = transform.transform_point(&Point3::new(pick(0), pick(1), pick(2)));
            for (axis, value) in [t.x, t.y, t.z].into_iter().enumerate() {
                min[axis] = min[axis].min(value);
                max[axis] = max[axis].max(value);
            }
        }
        let down = |v: f64| {
            let f = v as f32;
            if (f as f64) > v { f.next_down() } else { f }
        };
        let up = |v: f64| {
            let f = v as f32;
            if (f as f64) < v { f.next_up() } else { f }
        };
        mesh.local_bounds = Some([
            down(min[0]),
            down(min[1]),
            down(min[2]),
            up(max[0]),
            up(max[1]),
            up(max[2]),
        ]);
    }
    // #5792: a MappingTarget at georeferenced scale cannot be written into
    // f32 positions before the final RTC step. Keep its f64 translation in
    // the mesh origin and transform only small local vectors. Preserve the
    // existing byte path for ordinary maps and their determinism snapshots.
    let needs_origin = mesh.origin != [0.0; 3]
        || (0..3).any(|axis| transform[(axis, 3)].abs() >= LARGE_MAPPED_ORIGIN_M);
    if needs_origin {
        let old_origin = Point3::new(mesh.origin[0], mesh.origin[1], mesh.origin[2]);
        let new_origin = transform.transform_point(&old_origin);
        mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
            let v = transform.transform_vector(&Vector3::new(
                chunk[0] as f64,
                chunk[1] as f64,
                chunk[2] as f64,
            ));
            chunk[0] = v.x as f32;
            chunk[1] = v.y as f32;
            chunk[2] = v.z as f32;
        });
        mesh.origin = [new_origin.x, new_origin.y, new_origin.z];
    } else {
        mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
            let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let t = transform.transform_point(&point);
            chunk[0] = t.x as f32;
            chunk[1] = t.y as f32;
            chunk[2] = t.z as f32;
        });
    }

    crate::math::normals::transform_normals_in_place(&mut mesh.normals, transform);
}
