// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #1155: a Tekla IFC2X3 column whose `Body` is
//! `IfcBooleanClippingResult(.DIFFERENCE., IfcExtrudedAreaSolid, IfcHalfSpaceSolid)`
//! flew ~95 m away from its placement.
//!
//! The column is a `PK250X7.0` rectangular hollow section, 250×250 mm profile,
//! 11940 mm tall. The base extrusion has a flipped Position Z axis (`(0,~0,-1)`,
//! profile at `z=depth`) and the half-space cutting plane is coincident with the
//! host's top face. On that degenerate config the half-space clip leaked a
//! cap-box-sized polygon into the DIFFERENCE result: one profile dimension blew
//! up from 250 mm to ~97000 mm.
//!
//! Correct mesh extent is {250, 250, 11940} mm in some axis order.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use std::fs;
use std::path::PathBuf;

const FIXTURE: &str = "rust/geometry/tests/fixtures/issue_1155_halfspace_flyaway.ifc";
const HOST_ID: u32 = 113218;

fn fixture(rel: &str) -> Option<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(rel);
    fs::read_to_string(p).ok()
}

fn process_element_only(content: &str, host_id: u32) -> Option<Mesh> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    router.process_element(&entity, &mut decoder).ok()
}

/// Axis-aligned extents (max − min) of every vertex, in model units (mm here).
fn extents(m: &Mesh) -> [f64; 3] {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for v in m.positions.chunks_exact(3) {
        for k in 0..3 {
            let c = v[k] as f64;
            if c < mn[k] {
                mn[k] = c;
            }
            if c > mx[k] {
                mx[k] = c;
            }
        }
    }
    [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
}

#[test]
fn halfspace_clipped_column_does_not_fly_to_space() {
    let content = fixture(FIXTURE).expect("issue #1155 fixture must be staged");
    let mesh = process_element_only(&content, HOST_ID)
        .unwrap_or_else(|| panic!("#{HOST_ID} should process"));
    assert!(!mesh.is_empty(), "#{HOST_ID} produced no geometry");

    let mut ext = extents(&mesh);
    ext.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // Sorted: the two smallest are the 250 mm profile sides, the largest is the
    // 11940 mm length. Pre-fix the clip blew one profile side up to ~97000 mm.
    assert!(
        ext[0] < 300.0 && ext[1] < 300.0,
        "both profile dimensions must stay ~250 mm; got extents {ext:?} \
         (a ~97 m side means the half-space cap box leaked into the result)"
    );
    assert!(
        ext[2] < 12200.0,
        "length must stay ~11940 mm; got extents {ext:?}"
    );
}
