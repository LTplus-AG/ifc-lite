// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #4206 layer 4: `IfcStructuralCurveMember`s must mesh to a
//! visible ribbon instead of zero triangles.
//!
//! Before this change, `rep_filter::is_body_representation` had no entry for
//! `'Edge'` (the `RepresentationType` an `IfcStructuralCurveMember`'s
//! `IfcTopologyRepresentation` carries) and `processor_registry` had no slot
//! for `IfcEdge`, so every structural curve member's representation was
//! filtered out before any item was even looked at — the element meshed to
//! zero triangles and never appeared in `process_geometry`'s output at all.
//!
//! The fixture (`tests/models/ifcopenshell/structural_analysis_curve.ifc`)
//! has 3 `IfcStructuralCurveMember`s forming a continuous beam, in FILE units:
//!   - #228 "Curve Member #1": (0,0,0) -> (0,0,120)
//!   - #263 "Curve Member #2": (192,0,0) -> (192,0,120)
//!   - #296 "Curve Member #3": (0,0,120) -> (192,0,120)
//!
//! The project's assigned length unit (`IFCUNITASSIGNMENT` on `#207`) is
//! `#31`, an `IfcConversionBasedUnit` named 'inch' with a 0.0254 factor to
//! metre — NOT the plain `IfcSIUnit` `#28` (METRE) that conversion is
//! expressed against, which is easy to over-read as the project's own unit
//! since it is the only `IFCSIUNIT(*,.LENGTHUNIT.,...)` line in the file.
//! `process_geometry` reports this (`ModelMetadata.length_unit_scale ==
//! Some(0.0254)`) and scales mesh output to metres, so the expected
//! world-space coordinates below are the file coordinates x 0.0254.

use ifc_lite_core::EntityScanner;
use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "../../tests/models/ifcopenshell/structural_analysis_curve.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping structural curve member geometry regression: fixture missing at \
                 {FIXTURE} — run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

/// Inch -> metre, matching this fixture's assigned length unit `#31`.
const INCH_TO_METRE: f64 = 0.0254;

/// (name, expected_start, expected_end) for each of the 3 structural curve
/// members named in the module doc comment above, in FILE (inch) units.
fn expected_members_file_units() -> Vec<(&'static str, [f64; 3], [f64; 3])> {
    vec![
        ("Curve Member #1", [0., 0., 0.], [0., 0., 120.]),
        ("Curve Member #2", [192., 0., 0.], [192., 0., 120.]),
        ("Curve Member #3", [0., 0., 120.], [192., 0., 120.]),
    ]
}

fn to_metres(p: [f64; 3]) -> [f64; 3] {
    [p[0] * INCH_TO_METRE, p[1] * INCH_TO_METRE, p[2] * INCH_TO_METRE]
}

fn find_member_id(content: &str, name: &str) -> u32 {
    let needle = format!("'{name}'");
    let mut scanner = EntityScanner::new(content);
    while let Some((id, t, start, end)) = scanner.next_entity() {
        if t == "IFCSTRUCTURALCURVEMEMBER" && content[start..end].contains(&needle) {
            return id;
        }
    }
    panic!("fixture must contain an IfcStructuralCurveMember named {name}");
}

#[test]
fn structural_curve_members_mesh_to_a_visible_ribbon() {
    let Some(content) = read_fixture() else { return };

    let members = expected_members_file_units();
    let ids: Vec<u32> = members
        .iter()
        .map(|(name, _, _)| find_member_id(&content, name))
        .collect();
    assert_eq!(ids.len(), 3, "expected all 3 named structural curve members in the fixture");

    let result = process_geometry(&content);

    for ((name, start_file, end_file), &id) in members.iter().zip(ids.iter()) {
        let start = to_metres(*start_file);
        let end = to_metres(*end_file);
        let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == id).collect();
        assert_eq!(
            meshes.len(),
            1,
            "{name} (#{id}) must produce exactly one mesh, got {}",
            meshes.len()
        );
        let mesh = meshes[0];
        assert!(
            !mesh.positions.is_empty() && !mesh.indices.is_empty(),
            "{name} (#{id}) meshed empty — the 'Edge' representation is still being filtered out"
        );

        // Ribbon layout from IfcEdgeProcessor: 4 vertices, (0,1) straddle the
        // edge start and (2,3) straddle the edge end, so their midpoints
        // recover the exact IfcCartesianPoint coordinates regardless of the
        // ribbon's half-width.
        let world = |i: usize| {
            let b = i * 3;
            [
                mesh.positions[b] as f64 + mesh.origin[0],
                mesh.positions[b + 1] as f64 + mesh.origin[1],
                mesh.positions[b + 2] as f64 + mesh.origin[2],
            ]
        };
        assert_eq!(mesh.positions.len(), 4 * 3, "{name} (#{id}) expected exactly 4 ribbon vertices");
        let midpoint = |a: [f64; 3], b: [f64; 3]| [
            (a[0] + b[0]) / 2.0,
            (a[1] + b[1]) / 2.0,
            (a[2] + b[2]) / 2.0,
        ];
        let got_start = midpoint(world(0), world(1));
        let got_end = midpoint(world(2), world(3));

        const TOL: f64 = 1e-3;
        for axis in 0..3 {
            assert!(
                (got_start[axis] - start[axis]).abs() < TOL,
                "{name} (#{id}) start[{axis}]: expected {}, got {} (full: {got_start:?})",
                start[axis], got_start[axis]
            );
            assert!(
                (got_end[axis] - end[axis]).abs() < TOL,
                "{name} (#{id}) end[{axis}]: expected {}, got {} (full: {got_end:?})",
                end[axis], got_end[axis]
            );
        }
    }
}
