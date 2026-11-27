// SPDX-License-Identifier: MPL-2.0

mod voids_common;
#[path = "voids_common/split_wall.rs"]
#[allow(dead_code)]
mod split_wall;

use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use split_wall::Recess;
use voids_common::production::{build_void_index_like_production, process_host_like_production};

#[test]
fn oblique_partial_finish_has_no_membrane_11278() {
    let content = split_wall::wall_with_finish([0.; 2], 23., 2.0, Recess::FromInterface, 1.5);
    let voids = build_void_index_like_production(&content);
    let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");
    let ledger = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
    assert_eq!(ledger.unbalanced().count(), 0);
    let point = |i: u32| {
        let offset = i as usize * 3;
        let xyz = &mesh.positions[offset..offset + 3];
        ifc_lite_geometry::Vector3::new(f64::from(xyz[0]), f64::from(xyz[1]), f64::from(xyz[2]))
    };
    let area: f64 = mesh.indices.chunks_exact(3).map(|triangle| {
        let a = point(triangle[0]);
        (point(triangle[1]) - a).cross(&(point(triangle[2]) - a)).norm() * 0.5
    }).sum();
    let split = (area - 34.920).abs() <= 0.005;
    let fused = cfg!(feature = "csg_manifold_gate") && (area - 26.920).abs() <= 0.005;
    assert!(split || fused, "expected a clean recess floor, got {area} m²");
    assert!((mesh_volume(&mesh) - 2.448).abs() <= 0.0006);
}
