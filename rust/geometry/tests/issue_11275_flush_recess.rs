// SPDX-License-Identifier: MPL-2.0

#![cfg(not(feature = "csg_manifold_gate"))]

mod voids_common;
#[path = "voids_common/split_wall.rs"]
#[allow(dead_code)]
mod split_wall;

use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use split_wall::Recess;
use voids_common::production::{build_void_index_like_production, process_host_like_production};

#[test]
fn exact_fallback_keeps_core_under_narrow_finish_strip_11275() {
    use std::process::Command;
    const PROBE: &str = "IFCLITE_PROBE_NARROW_RECESS_11275";
    if std::env::var_os(PROBE).is_none() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "exact_fallback_keeps_core_under_narrow_finish_strip_11275", "--nocapture"])
            .env("IFC_LITE_PRISM_CUT", "0")
            .env(PROBE, "1")
            .output()
            .unwrap();
        assert!(child.status.success(), "{}", String::from_utf8_lossy(&child.stderr));
        return;
    }
    let content = split_wall::wall_with_finish([0.; 2], 0., 2.274, Recess::ToInterfaceAtTop, 1.05);
    let voids = build_void_index_like_production(&content);
    let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");
    let ledger = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
    assert_eq!(ledger.unbalanced().count(), 0);
    let volume = mesh_volume(&mesh);
    assert!((volume - 2.4372).abs() < 0.0002, "expected 2.4372 m³, got {volume} m³");
}
