// SPDX-License-Identifier: MPL-2.0
//! Source-free per-frame AABB calculation; preserves world/RTC corner arithmetic.
use crate::{Mesh, Point3};
use nalgebra::Matrix4;

pub(super) fn evaluate(
    mesh: &Mesh,
    placement_transform: &Matrix4<f64>,
    rtc: (f64, f64, f64),
) -> (Point3<f64>, Point3<f64>) {
    // Mesh::bounds is local to mesh.positions. Mapped items can
    // carry a large f64 origin that must be folded in before the
    // element placement, or the cutter box lands near zero.
    let (mesh_min, mesh_max) = mesh.bounds();

    // Transform corner points to world coordinates
    let corners = [
        Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_min.z as f64),
        Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_min.z as f64),
        Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_min.z as f64),
        Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_min.z as f64),
        Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_max.z as f64),
        Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_max.z as f64),
        Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_max.z as f64),
        Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_max.z as f64),
    ];

    // Transform all corners and compute new AABB
    let transformed: Vec<Point3<f64>> = corners
        .iter()
        .map(|p| {
            let source = Point3::new(
                p.x + mesh.origin[0],
                p.y + mesh.origin[1],
                p.z + mesh.origin[2],
            );
            placement_transform.transform_point(&source)
        })
        .collect();

    let world_min = Point3::new(
        transformed
            .iter()
            .map(|p| p.x)
            .fold(f64::INFINITY, f64::min),
        transformed
            .iter()
            .map(|p| p.y)
            .fold(f64::INFINITY, f64::min),
        transformed
            .iter()
            .map(|p| p.z)
            .fold(f64::INFINITY, f64::min),
    );
    let world_max = Point3::new(
        transformed
            .iter()
            .map(|p| p.x)
            .fold(f64::NEG_INFINITY, f64::max),
        transformed
            .iter()
            .map(|p| p.y)
            .fold(f64::NEG_INFINITY, f64::max),
        transformed
            .iter()
            .map(|p| p.z)
            .fold(f64::NEG_INFINITY, f64::max),
    );

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
