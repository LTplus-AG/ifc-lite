// SPDX-License-Identifier: MPL-2.0
//! Source-free per-frame AABB calculation; preserves world/RTC arithmetic.
use crate::math::aabb::Aabb3;
use crate::{Mesh, Point3};
use nalgebra::Matrix4;

/// The bounds of `mesh` once placed by `placement_transform`, less `rtc`.
///
/// Every vertex is placed and the box taken of the result. Placing the eight
/// corners of the item-frame box instead gives a box of a box: for an item
/// turned in its own frame and turned back by its placement (a solid whose
/// Position undoes its wall's rotation) that box is larger than the opening,
/// and an axis-aligned opening is cut by its bounds.
pub(crate) fn evaluate(
    mesh: &Mesh,
    placement_transform: &Matrix4<f64>,
    rtc: (f64, f64, f64),
) -> (Point3<f64>, Point3<f64>) {
    // Mapped items can carry a large f64 origin that must be folded in before
    // the element placement, or the cutter box lands near zero.
    let place = |local: &[f32]| {
        placement_transform.transform_point(&Point3::new(
            local[0] as f64 + mesh.origin[0],
            local[1] as f64 + mesh.origin[1],
            local[2] as f64 + mesh.origin[2],
        ))
    };
    // An empty mesh keeps its historical bounds: the placed item origin.
    let origin = [0.0f32; 3];
    let vertices = if mesh.is_empty() { &origin[..] } else { &mesh.positions[..] };
    let placed = Aabb3::from_points(vertices.chunks_exact(3).map(|vertex| place(vertex).coords.into()));
    let (world_min, world_max) = (Point3::from(placed.min), Point3::from(placed.max));

    // Apply RTC offset to opening bounds so they match wall mesh coordinate system
    // Wall mesh positions have RTC subtracted during transform_mesh, so opening bounds must match
    let rtc_min = Point3::new(
        world_min.x - rtc.0,
        world_min.y - rtc.1,
        world_min.z - rtc.2,
    );
    let rtc_max = Point3::new(
        world_max.x - rtc.0,
        world_max.y - rtc.1,
        world_max.z - rtc.2,
    );

    (rtc_min, rtc_max)
}

#[cfg(test)]
mod tests {
    use super::evaluate;
    use crate::{Mesh, Point3};
    use nalgebra::{Matrix4, Vector3};

    /// A 2 x 0.4 x 1 box turned 30 degrees about Z in its item frame.
    fn turned_box(angle: f64) -> Mesh {
        let (sin, cos) = angle.sin_cos();
        let mut mesh = Mesh::new();
        for corner in 0..8u32 {
            let (x, y, z) = (
                if corner & 1 == 0 { 0.0 } else { 2.0 },
                if corner & 2 == 0 { 0.0 } else { 0.4 },
                if corner & 4 == 0 { 0.0 } else { 1.0 },
            );
            mesh.add_vertex(Point3::new(x * cos - y * sin, x * sin + y * cos, z), Vector3::z());
        }
        for quad in [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]] {
            mesh.add_triangle(quad[0], quad[1], quad[2]);
            mesh.add_triangle(quad[0], quad[2], quad[3]);
        }
        mesh
    }

    #[test]
    fn a_box_turned_back_by_its_placement_keeps_its_own_bounds() {
        let angle = 30.0_f64.to_radians();
        let mesh = turned_box(angle);
        let back = Matrix4::new_rotation(Vector3::z() * -angle);
        let (min, max) = evaluate(&mesh, &back, (0.0, 0.0, 0.0));
        // Placed, the box is axis-aligned again: 2 x 0.4 x 1 at the origin.
        // The eight corners of its item-frame box gave 2.27 x 1.87.
        for (got, want) in [(min.x, 0.0), (min.y, 0.0), (min.z, 0.0), (max.x, 2.0), (max.y, 0.4), (max.z, 1.0)] {
            assert!((got - want).abs() < 1.0e-6, "bounds {min:?} .. {max:?}");
        }
    }

    #[test]
    fn the_rtc_offset_and_the_item_origin_are_folded() {
        let mut mesh = turned_box(0.0);
        mesh.origin = [100.0, 200.0, 300.0];
        let moved = Matrix4::new_translation(&Vector3::new(1.0, 2.0, 3.0));
        let (min, max) = evaluate(&mesh, &moved, (0.5, 0.5, 0.5));
        assert_eq!((min.x, min.y, min.z), (100.5, 201.5, 302.5));
        assert!((max.x - 102.5).abs() < 1.0e-6 && (max.y - 201.9).abs() < 1.0e-6 && (max.z - 303.5).abs() < 1.0e-6);
    }
}
