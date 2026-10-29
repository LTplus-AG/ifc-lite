// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #8276: two openings of the same authored size whose ring
//! coordinates differ below the f32 position ULP must keep their own normals.
//! `ifc_lite_geometry`'s `meshes_equal` says why that pair exists and what
//! served one for the other.
//!
//! The swap is reachable from either side, an element's own job or the host
//! wall's job meshing it as a cutter, so in the pipeline it followed the
//! thread schedule. `mesh_on_one_router` is the single-threaded shape of the
//! same cache, so it is deterministic here.

mod f32_identical_openings;

use f32_identical_openings::{fixture_content, mesh_on_one_router, OPENING_A, OPENING_B};

/// Guards the collision the regression below relies on: the two openings
/// still ship byte-identical positions and indices. Nothing else covers that,
/// and without it the regression could pass because the pair stopped
/// colliding rather than because the cache stopped confusing it. A failure
/// here means re-authoring the fixture, not relaxing the assertion.
#[test]
fn fixture_still_ships_identical_positions() {
    let content = fixture_content();
    // One router per opening, so neither can be served the other's mesh.
    let a = mesh_on_one_router(&content, &[OPENING_A]).pop().expect("A meshes");
    let b = mesh_on_one_router(&content, &[OPENING_B]).pop().expect("B meshes");

    assert_eq!(a.positions, b.positions, "fixture rot: the openings no longer share f32 positions");
    assert_eq!(a.indices, b.indices, "fixture rot: the openings no longer share indices");
}

/// THE REGRESSION. Meshed in sequence on one router, the second opening must
/// come back with its OWN normals, not the first's.
#[test]
fn an_f32_identical_neighbour_does_not_supply_its_normals() {
    let content = fixture_content();

    let alone = mesh_on_one_router(&content, &[OPENING_B]).pop().expect("B meshes");
    let shared = mesh_on_one_router(&content, &[OPENING_A, OPENING_B]);
    let (a, b) = (&shared[0], &shared[1]);

    assert_eq!(
        b.normals, alone.normals,
        "#{OPENING_B} came back with different normals depending on whether \
         #{OPENING_A} had been meshed on the same router first (#8276)"
    );
    assert_ne!(
        a.normals, b.normals,
        "the two openings' normals are equal after sharing a router, so one \
         was served for the other (#8276)"
    );
}
