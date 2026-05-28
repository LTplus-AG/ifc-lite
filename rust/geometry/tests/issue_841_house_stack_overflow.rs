// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Repro / regression probe for issue #841 — House.ifc trips
//! `RangeError: Maximum call stack size exceeded` in the browser.
//!
//! The fixture is an IFC2X3 house with 173 boolean results, 478 composite
//! curves, 201 local placements and 162 mapped-item references. We drive
//! every renderable product through `process_element` here and treat a
//! panic (which would manifest as a stack overflow in WASM) as the
//! reported failure mode.

use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/841_house_stack_overflow.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-841 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

#[test]
fn house_processes_every_product_without_panicking() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Collect all renderable product entity ids first so we don't borrow
    // `decoder` across the scanner iterator + `process_element` call.
    let mut product_ids: Vec<u32> = Vec::new();
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, type_name, _, _)) = scanner.next_entity() {
        if has_geometry_by_name(type_name) {
            product_ids.push(id);
        }
    }

    assert!(
        !product_ids.is_empty(),
        "fixture missing renderable products?",
    );

    let mut total_tris = 0usize;
    for id in product_ids {
        let entity = match decoder.decode_by_id(id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        match router.process_element(&entity, &mut decoder) {
            Ok(mesh) => total_tris += mesh.indices.len() / 3,
            // process_element returns errors for malformed pieces; that's
            // fine. The fail mode we're catching is a stack-overflow
            // panic during processing, which `cargo test` surfaces as a
            // test failure even though the test never reaches an assert.
            Err(_) => {}
        }
    }

    assert!(
        total_tris > 0,
        "no triangles produced from the entire House fixture",
    );
}
