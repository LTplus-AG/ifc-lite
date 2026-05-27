// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #828 — `IfcSectionedSolidHorizontal` must
//! produce a non-empty mesh instead of erroring with "Unsupported
//! representation type".
//!
//! The bridge fixture `tests/models/issues/828_sectioned-solid.ifc`
//! contains 16 `IfcSectionedSolidHorizontal` entities. Cross-section
//! profile types in the file:
//!   • `IfcArbitraryClosedProfileDef` over `IfcIndexedPolyCurve` (pier
//!     caps, abutment skirts, deck slabs)
//!   • `IfcMirroredProfileDef` wrapping an arbitrary parent (handrail)
//!   • `IfcAsymmetricIShapeProfileDef` (steel girders) — added to the
//!     profile processor as part of this fix
//!
//! Bounds asserted on entity #69 (the first sectioned solid in the
//! file) — a ~134 m long pier — match the dimensions visible in viewers
//! that support the entity (Solibri, BIMcollab Zoom).

use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/828_sectioned-solid.ifc";

/// See `issue_820_trimmed_curve_planeangleunit::lfs_pointer_prefix` for
/// why this string is built at runtime instead of being a string literal.
fn lfs_pointer_prefix() -> String {
    format!("version {}{}", "https://git-lfs.github.com/", "spec/")
}

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with(&lfs_pointer_prefix()) => {
            eprintln!(
                "skipping issue-828 regression: fixture at {FIXTURE} is a Git LFS \
                 pointer — run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-828 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

/// Entity #69 is the canonical example from the issue — a 134 m bridge
/// pier with five `IfcArbitraryClosedProfileDef` cross-sections swept
/// along an `IfcAlignmentCurve` directrix (a horizontal circular arc on
/// a longitudinal grade with a parabolic sag at the far end). After the
/// fix the loft produces a closed solid that:
///   • spans ~134 m of arc length along the curve,
///   • curves laterally by several metres (would be 0 for a straight
///     sweep — pre-curve-evaluation MVP failed this),
///   • rises along the longitudinal grade (start z ≈ 4.84 m, end z ≈
///     13.6 m before the profile vertical extent).
#[test]
fn sectioned_solid_horizontal_lofts_pier_69() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    // `with_units` lets the router apply the file's length-unit scale
    // (this fixture is in inches; output bounds end up in metres).
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let entity = decoder
        .decode_by_id(69)
        .expect("decode IfcSectionedSolidHorizontal #69");
    assert_eq!(entity.ifc_type, IfcType::IfcSectionedSolidHorizontal);

    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .expect("process #69 — pre-fix this errored 'Unsupported representation type'");

    assert!(
        !mesh.positions.is_empty(),
        "#69 produced empty mesh — loft fell through",
    );
    assert_eq!(mesh.indices.len() % 3, 0, "#69 indices not in triples");

    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            if p[axis] < min[axis] {
                min[axis] = p[axis];
            }
            if p[axis] > max[axis] {
                max[axis] = p[axis];
            }
        }
    }

    // The alignment's start heading is 13.36° from +X with a CW arc, so
    // after ~134 m of arc length the X span dominates and Y carries the
    // lateral deflection. With the curve evaluated correctly the X span
    // is large (~130 m) and the Y span is several metres (not zero).
    let x_span = max[0] - min[0];
    let y_span = max[1] - min[1];
    let z_span = max[2] - min[2];
    assert!(
        x_span > 125.0 && x_span < 145.0,
        "#69 X span {} m outside expected ~130 m range",
        x_span,
    );
    // Lateral deflection: pre-fix straight sweep gave y_span = profile
    // width (4.6 m); curve-aware sweep adds the chord-to-arc offset
    // plus profile width → ~10 m. Setting the floor at 6 m catches a
    // regression to straight-sweep without being noisy.
    assert!(
        y_span > 6.0,
        "#69 Y span {} m is suspiciously small — sweep may have reverted to straight",
        y_span,
    );
    assert!(
        z_span > 8.0,
        "#69 Z span {} m is too small — longitudinal grade is missing",
        z_span,
    );

    // Sanity: end station's centroid should be ~134 m away from start
    // station's centroid along the alignment chord, not the body axis.
    let chord = ((max[0] - 0.0_f32).hypot(min[1])).hypot(max[2] - min[2]);
    assert!(
        chord > 120.0,
        "#69 chord {} m too short — the swept solid collapsed",
        chord,
    );
}

/// Every `IfcSectionedSolidHorizontal` in the fixture must now produce a
/// non-empty mesh. The fixture exercises three profile pathways:
///   • arbitrary closed (pier caps, abutments)
///   • mirrored derived (handrail #415 / #424)
///   • asymmetric I-shape (steel girders #441–#470)
/// Pre-fix this loop reported 9 ok / 7 errored; after the profile +
/// router changes it reports 16 / 0.
#[test]
fn every_sectioned_solid_horizontal_in_fixture_lofts() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let mut ids: Vec<u32> = Vec::new();
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, type_name, _, _)) = scanner.next_entity() {
        if type_name == "IFCSECTIONEDSOLIDHORIZONTAL" {
            ids.push(id);
        }
    }
    assert!(
        ids.len() >= 16,
        "expected at least 16 IfcSectionedSolidHorizontal entities, found {}",
        ids.len(),
    );

    let mut failures: Vec<String> = Vec::new();
    for &id in &ids {
        let entity = match decoder.decode_by_id(id) {
            Ok(e) => e,
            Err(e) => {
                failures.push(format!("#{id}: decode error {e}"));
                continue;
            }
        };
        match router.process_representation_item(&entity, &mut decoder) {
            Ok(mesh) if !mesh.positions.is_empty() => {}
            Ok(_) => failures.push(format!("#{id}: empty mesh")),
            Err(e) => failures.push(format!("#{id}: {e}")),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} IfcSectionedSolidHorizontal entities failed to loft:\n  {}",
        failures.len(),
        ids.len(),
        failures.join("\n  "),
    );
}
