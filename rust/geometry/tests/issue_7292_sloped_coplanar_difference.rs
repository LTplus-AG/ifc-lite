// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #7292: `IfcBooleanResult(.DIFFERENCE., A, B)` where A is a
//! 54 mm extrusion of a notched footprint on a 2 % slope and B is a faceted
//! prism of the same footprint bounded by planes on the same slope. A is
//! 25 mm longer at one end (x = -3025 instead of -3000 mm); every other side
//! of A lies inside or flush with B. Only that 25 mm strip may remain.
//! IfcOpenShell 0.9.0 and web-ifc 0.0.78 both return it as 12 triangles.
//!
//! The file is the reporter's generated repro (IFC2X3, millimetres), verbatim.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use std::path::PathBuf;

const FIXTURE: &str = "tests/fixtures/issue_7292_sloped_coplanar_difference.ifc";
/// `IFCBUILDINGELEMENTPART('...','Gravel layer')`.
const ELEMENT_ID: u32 = 107;

fn mesh() -> Mesh {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let content = std::fs::read_to_string(&path).expect("committed #7292 fixture");
    let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let entity = decoder.decode_by_id(ELEMENT_ID).expect("element decodes");
    GeometryRouter::with_scale(0.001)
        .process_element(&entity, &mut decoder)
        .expect("element meshes")
}

/// Bounds over the vertices the index buffer actually references (the
/// reporter's measure; unreferenced vertices are not geometry).
fn indexed_bounds(m: &Mesh) -> ([f64; 3], [f64; 3]) {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for &i in &m.indices {
        for k in 0..3 {
            let c = m.positions[i as usize * 3 + k] as f64 + m.origin[k];
            lo[k] = lo[k].min(c);
            hi[k] = hi[k].max(c);
        }
    }
    (lo, hi)
}

#[test]
fn issue_7292_only_the_25mm_strip_survives_the_sloped_difference() {
    let m = mesh();
    assert!(!m.is_empty(), "the 25 mm strip must remain");
    let (lo, hi) = indexed_bounds(&m);
    // Independent IfcOpenShell replay gives these indexed world bounds.
    // 0.1 mm covers f32 storage and the kernel snap. Checking all three
    // dimensions also rejects a collapsed strip or lost model placement.
    let expected_lo = [-3.025, 0.0, 4.548];
    let expected_hi = [-3.000, 1.099780, 4.623996];
    for k in 0..3 {
        assert!(
            (lo[k] - expected_lo[k]).abs() < 1.0e-4
                && (hi[k] - expected_hi[k]).abs() < 1.0e-4,
            "#7292: axis {k} bounds [{}, {}], expected [{}, {}] ({} triangles)",
            lo[k], hi[k], expected_lo[k], expected_hi[k], m.triangle_count()
        );
    }
}
