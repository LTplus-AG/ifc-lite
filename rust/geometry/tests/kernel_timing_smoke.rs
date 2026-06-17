// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Smoke test for the Step-0 kernel timing instrumentation: a real exact-kernel
//! boolean must populate the per-phase timers + predicate-tier counters when
//! built with `--features kernel-timing`, and record NOTHING (zero overhead)
//! otherwise.
//!
//! cargo test -p ifc-lite-geometry --features kernel-timing --test kernel_timing_smoke -- --nocapture

use ifc_lite_geometry::kernel::timing;
use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::Point3;

/// Closed axis-aligned box (12 triangles), outward-wound.
fn box_mesh(min: [f32; 3], max: [f32; 3]) -> Mesh {
    let mut m = Mesh::new();
    let c = [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]],
    ];
    let faces: [([usize; 4], [f32; 3]); 6] = [
        ([0, 3, 2, 1], [0.0, 0.0, -1.0]),
        ([4, 5, 6, 7], [0.0, 0.0, 1.0]),
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
        ([2, 3, 7, 6], [0.0, 1.0, 0.0]),
        ([0, 4, 7, 3], [-1.0, 0.0, 0.0]),
        ([1, 2, 6, 5], [1.0, 0.0, 0.0]),
    ];
    for (idx, n) in faces {
        let b = (m.positions.len() / 3) as u32;
        for &i in &idx {
            m.positions.extend_from_slice(&c[i]);
            m.normals.extend_from_slice(&n);
        }
        m.indices
            .extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }
    m
}

#[test]
fn boolean_populates_kernel_timing() {
    let _ = timing::take(); // clear any cross-test residue
    let clip = ClippingProcessor::new();
    // A window-ish box cut through a wall slab → a real arrangement boolean.
    let host = box_mesh([0.0, 0.0, 0.0], [4.0, 0.2, 3.0]);
    let cutter = box_mesh([1.0, -0.1, 1.0], [2.0, 0.3, 2.0]);
    let out = clip.subtract_box(&host, Point3::new(1.0, -0.1, 1.0), Point3::new(2.0, 0.3, 2.0));
    assert!(out.is_ok(), "subtract should succeed");
    let _ = cutter; // host/cutter both exercise mesh_to_tris

    let kt = timing::take();
    eprintln!("[kernel-timing smoke] {}", kt.format());

    if cfg!(feature = "kernel-timing") {
        assert!(
            !kt.is_empty(),
            "kernel-timing feature ON but nothing was recorded"
        );
        // A box−box arrangement must exercise the predicate cascade and the
        // mesh-conversion phases at minimum.
        assert!(kt.tiers[0] > 0, "no predicate evaluations recorded");
        assert!(
            kt.phase_ops.iter().any(|&o| o > 0),
            "no phase invocations recorded"
        );
    } else {
        assert!(kt.is_empty(), "kernel-timing OFF must record nothing");
    }
}
