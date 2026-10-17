// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7688 KERNEL-17: the public `mesh_bridge::subtract` / `subtract_many`
//! entry points own their #1109 budget, as `union` and `intersection` do.
//!
//! Before the fix they neither reset the per-boolean counter nor checked it,
//! so a thread whose counter an earlier boolean left over the cap (the fuzz
//! target runs `subtract` in a loop on one thread) got a truncated
//! arrangement back, reported as an ordinary result.
//!
//! Each test runs on its own test thread, and the budget counters are
//! thread-local, so the escalations charged here touch no other test. No
//! test changes the process-wide caps.

use ifc_lite_geometry::kernel::budget;
use ifc_lite_geometry::kernel::mesh_bridge::{subtract, subtract_many, BatchSubtract};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::{Mesh, Point3, Vector3};

/// An outward-wound axis-aligned box `[lo, hi]`.
fn axis_box(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
    let corner = |i: usize| {
        Point3::new(
            if i & 1 == 0 { lo[0] } else { hi[0] },
            if i & 2 == 0 { lo[1] } else { hi[1] },
            if i & 4 == 0 { lo[2] } else { hi[2] },
        )
    };
    let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]];
    let mut mesh = Mesh::new();
    for i in 0..8 {
        mesh.add_vertex(corner(i), Vector3::zeros());
    }
    for [a, b, c, d] in quads {
        mesh.indices.extend_from_slice(&[a, b, c, a, c, d]);
    }
    mesh
}

/// A 2 x 2 x 2 host and a corner box overlapping it in a unit cube.
fn operands() -> (Mesh, Mesh) {
    (
        axis_box([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]),
        axis_box([1.0, 1.0, 1.0], [3.0, 3.0, 3.0]),
    )
}

/// Leave this thread's per-boolean counter at the default cap, as a previous
/// tripped boolean on the same thread would.
fn leave_the_boolean_counter_tripped() {
    budget::begin();
    let cap = budget::cap().expect("the default per-boolean cap is bounded");
    for _ in 0..cap {
        budget::note_escalation();
    }
    assert!(budget::tripped(), "precondition: the stale counter is over the cap");
}

/// A stale counter left by an earlier boolean must not truncate the next
/// one: `subtract` starts its own count and returns the whole cut.
#[test]
fn issue_7688_kernel_17_subtract_resets_a_stale_boolean_counter() {
    let (host, cutter) = operands();
    let clean = mesh_volume(&subtract(&host, &cutter));
    assert!((clean - 7.0).abs() < 1e-9, "control: clean subtract volume {clean}");

    leave_the_boolean_counter_tripped();
    let after = subtract(&host, &cutter);
    let volume = mesh_volume(&after);
    assert!((volume - 7.0).abs() < 1e-9, "subtract after a stale trip: volume {volume}, {} tris", after.triangle_count());
}

#[test]
fn issue_7688_kernel_17_subtract_many_resets_a_stale_boolean_counter() {
    let (host, cutter) = operands();
    leave_the_boolean_counter_tripped();
    match subtract_many(&host, &[&cutter]) {
        BatchSubtract::Cut(mesh) => {
            let volume = mesh_volume(&mesh);
            assert!((volume - 7.0).abs() < 1e-9, "subtract_many after a stale trip: volume {volume}");
        }
        other => panic!("subtract_many after a stale trip: {other:?}"),
    }
}

/// A genuine trip (here, the enclosing element's budget is spent, which a
/// per-boolean `begin` deliberately does not reset) refuses rather than
/// returning a partial arrangement as a result: `subtract` is empty, as
/// `union` and `intersection` are, and `subtract_many` is `Nonconforming`,
/// the outcome its callers already fall back from.
#[test]
fn issue_7688_kernel_17_a_spent_element_budget_refuses_instead_of_truncating() {
    let (host, cutter) = operands();
    let _element = budget::enter_element();
    let element_cap = budget::element_cap().expect("the default element cap is bounded");
    for _ in 0..element_cap {
        budget::note_escalation();
    }
    assert!(budget::tripped(), "precondition: the element budget is spent");

    let single = subtract(&host, &cutter);
    assert!(single.is_empty(), "subtract under a spent budget returned {} tris", single.triangle_count());
    let batch = subtract_many(&host, &[&cutter]);
    assert!(matches!(batch, BatchSubtract::Nonconforming), "subtract_many under a spent budget: {batch:?}");
}
