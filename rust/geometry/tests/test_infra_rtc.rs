// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Integration tests for infrastructure model RTC detection.
//!
//! Tests against real infrastructure IFC files in `tests/models/local/`.
//! These files are gitignored (private) — tests are `#[ignore]` by default
//! and run only when files are present.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

const LOCAL_MODELS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/models/local");

fn load_file(name: &str) -> Option<String> {
    let path = format!("{}/{}", LOCAL_MODELS_DIR, name);
    std::fs::read_to_string(&path).ok()
}

/// Test RTC detection on real infrastructure IFC files.
/// These models have identity placement and world-space Brep coordinates.
#[test]
#[ignore] // Run with `cargo test -p ifc-lite-geometry -- --ignored test_real_infra`
fn test_real_infra_rtc_detection() {
    let files = [
        "PBPCD-TFNSW-0612-PV-M3D-000006.ifc",
        "PBPCD-TFNSW-0620-PV-M3D-000005.ifc",
        "PBPCD-TFNSW-PCBP-PV-M3D-000005.ifc",
    ];

    for file_name in &files {
        let content = match load_file(file_name) {
            Some(c) => c,
            None => {
                eprintln!("Skipping {} (not found in tests/models/local/)", file_name);
                continue;
            }
        };

        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let router = GeometryRouter::with_units(&content, &mut decoder);

        let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);

        println!(
            "{}: RTC offset = ({:.1}, {:.1}, {:.1})",
            file_name, offset.0, offset.1, offset.2
        );

        // Must detect large coordinates (GDA2020 MGA56: X ~280000, Y ~6214000)
        assert!(
            offset.0.abs() > 10000.0 || offset.1.abs() > 10000.0,
            "{}: Expected large RTC offset, got ({:.1}, {:.1}, {:.1})",
            file_name,
            offset.0,
            offset.1,
            offset.2
        );
    }
}

/// Test that processing geometry with RTC produces small vertex coordinates.
#[test]
#[ignore]
fn test_real_infra_rtc_application() {
    let content = match load_file("PBPCD-TFNSW-0612-PV-M3D-000006.ifc") {
        Some(c) => c,
        None => {
            eprintln!("Skipping test (file not found)");
            return;
        }
    };

    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);

    let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
    println!("RTC offset: ({:.1}, {:.1}, {:.1})", offset.0, offset.1, offset.2);
    router.set_rtc_offset(offset);

    // Find first building element and process it
    let mut scanner = EntityScanner::new(&content);
    let mut processed = 0;
    let mut max_coord = 0.0f32;

    while let Some((_id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }
        if let Ok(entity) = decoder.decode_at(start, end) {
            let has_rep = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
            if !has_rep {
                continue;
            }
            if let Ok(mesh) = router.process_element(&entity, &mut decoder) {
                if mesh.positions.is_empty() {
                    continue;
                }
                for chunk in mesh.positions.chunks_exact(3) {
                    let mc = chunk[0].abs().max(chunk[1].abs()).max(chunk[2].abs());
                    max_coord = max_coord.max(mc);
                }
                processed += 1;
                if processed >= 5 {
                    break;
                }
            }
        }
    }

    assert!(processed > 0, "Expected to process at least one non-empty mesh");

    println!(
        "Processed {} elements, max coordinate after RTC: {:.1}",
        processed, max_coord
    );

    // After RTC, coordinates should be within ~50km of origin (model extents)
    assert!(
        max_coord < 50_000.0,
        "Max coordinate after RTC should be < 50km, got {:.1}m",
        max_coord
    );
}

/// Test that multiple infrastructure models produce consistent, federatable RTC offsets.
#[test]
#[ignore]
fn test_real_infra_federation_alignment() {
    let files = [
        "PBPCD-TFNSW-0612-PV-M3D-000006.ifc",
        "PBPCD-TFNSW-0620-PV-M3D-000005.ifc",
    ];

    let mut offsets = Vec::new();
    for file_name in &files {
        let content = match load_file(file_name) {
            Some(c) => c,
            None => {
                eprintln!("Skipping {} (not found)", file_name);
                return;
            }
        };

        let entity_index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, entity_index);
        let router = GeometryRouter::with_units(&content, &mut decoder);
        let offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
        println!("{}: RTC = ({:.1}, {:.1}, {:.1})", file_name, offset.0, offset.1, offset.2);
        offsets.push(offset);
    }

    if offsets.len() < 2 {
        return;
    }

    let delta_x = offsets[0].0 - offsets[1].0;
    let delta_y = offsets[0].1 - offsets[1].1;
    let delta_z = offsets[0].2 - offsets[1].2;

    println!("RTC delta: ({:.1}, {:.1}, {:.1})", delta_x, delta_y, delta_z);

    // Delta should survive f32 round-trip for viewer alignment
    let dx32 = delta_x as f32;
    let dy32 = delta_y as f32;
    let precision_loss_x = (dx32 as f64 - delta_x).abs();
    let precision_loss_y = (dy32 as f64 - delta_y).abs();

    println!(
        "f32 precision loss: X={:.3}m, Y={:.3}m",
        precision_loss_x, precision_loss_y
    );

    assert!(
        precision_loss_x < 1.0,
        "X delta f32 round-trip error too large: {:.3}m",
        precision_loss_x
    );
    assert!(
        precision_loss_y < 1.0,
        "Y delta f32 round-trip error too large: {:.3}m",
        precision_loss_y
    );
}
