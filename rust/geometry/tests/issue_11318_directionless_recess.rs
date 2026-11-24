// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #11318: a tessellated recess carries no extrusion direction. When the
//! exact cut is rejected it reaches the #635 box fallback, which must not
//! widen the air-only cutter through the core.

mod voids_common;
#[path = "voids_common/split_wall.rs"]
#[allow(dead_code)]
mod split_wall;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use ifc_lite_geometry::GeometryRouter;
use voids_common::production::build_void_index_like_production;

/// With the gate, the kernel's cut is rejected and the #635 fallback runs.
#[cfg(feature = "csg_manifold_gate")]
#[test]
fn gate_rejected_directionless_recess_keeps_the_core_11318() {
    keeps_the_core("gate_rejected_directionless_recess_keeps_the_core_11318");
}

/// Without the gate, the exact cut is the reference the fallback must match.
#[cfg(not(feature = "csg_manifold_gate"))]
#[test]
fn exact_directionless_recess_keeps_the_core_11318() {
    keeps_the_core("exact_directionless_recess_keeps_the_core_11318");
}

/// A stub wall shorter than it is thick: the inferred thinnest axis is its
/// length, not the recess depth, so the air proof must try the other axes.
#[cfg(feature = "csg_manifold_gate")]
#[test]
fn gate_rejected_directionless_recess_in_a_stub_wall_keeps_the_core_11318() {
    keeps_the_core("gate_rejected_directionless_recess_in_a_stub_wall_keeps_the_core_11318");
}

#[cfg(not(feature = "csg_manifold_gate"))]
#[test]
fn exact_directionless_recess_in_a_stub_wall_keeps_the_core_11318() {
    keeps_the_core("exact_directionless_recess_in_a_stub_wall_keeps_the_core_11318");
}

fn keeps_the_core(test_name: &str) {
    use std::process::Command;
    const PROBE: &str = "IFCLITE_PROBE_DIRECTIONLESS_RECESS_11318";
    if std::env::var_os(PROBE).is_none() {
        // Force the exact route, which hands a rejected cut to the fallback.
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env("IFC_LITE_PRISM_CUT", "0")
            .env(PROBE, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&child.stdout);
        assert!(child.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&child.stderr));
        assert!(stdout.contains("1 passed; 0 failed"), "the child must run the regression");
        return;
    }
    let stub = test_name.contains("stub_wall");
    // 4 m x 3 m x 0.2 m of core and 0.5 m x 3 m x 12 mm of finish. The
    // chamfered recess at x in [1, 2] lies beyond the finish, so nothing goes.
    // The stub wall's recess likewise lies beyond its finish.
    let mut failures = Vec::new();
    for offset in [2.137, 2.274, 2.411] {
        // The stub keeps 0.0918 m³, so its tolerance must stay well under
        // the 0.0006 m³ of finish a box widened along x would remove.
        let (content, expected, tolerance) = if stub {
            (split_wall::stub_wall_with_tessellated_recess(offset), split_wall::stub_wall_volume(), 5.0e-5)
        } else {
            (split_wall::wall_with_tessellated_recess(offset, 0.5), 2.418, 6.0e-4)
        };
        let voids = build_void_index_like_production(&content);
        let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
        let wall = decoder.decode_by_id(100).unwrap();
        let router = GeometryRouter::with_scale(1.0);
        let mesh = router.process_element_with_voids(&wall, &mut decoder, &voids).expect("the wall meshes");
        let open = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle).unbalanced().count();
        let volume = mesh_volume(&mesh);
        if open != 0 || (volume - expected).abs() > tolerance {
            failures.push(format!("y={offset}: {volume:.6} m³, {open} unbalanced edges"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
