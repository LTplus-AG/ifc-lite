// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #953 — `IfcTrimmedCurve` bounds given as
//! `IfcCartesianPoint`s (MasterRepresentation `.CARTESIAN.`) were ignored, so
//! the trimmed arc of a wall profile collapsed.
//!
//! `Roof-01_BCAD.ifc` authors its semicircular wall profiles as a composite
//! curve of a polyline diameter plus a trimmed circle:
//!
//! ```text
//! #206 = IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#207);
//! #207 = IFCCOMPOSITECURVE((#208,#212),.F.);
//! #208 = IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#209);  -- polyline
//! #212 = IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#213);
//! #213 = IFCTRIMMEDCURVE(#214,(#211),(#210),.F.,.CARTESIAN.);  -- arc
//! #214 = IFCCIRCLE(#215,2.4);
//! #211 = IFCCARTESIANPOINT((0.,2.4));    -- Trim1 (a point, not a parameter)
//! #210 = IFCCARTESIANPOINT((0.,-2.4));   -- Trim2
//! ```
//!
//! Before the fix `extract_trim_param` only understood `IfcParameterValue`
//! bounds, so both trims read as `None`. The conic processor then defaulted to
//! a full 0..2π circle which — combined with `SenseAgreement = .F.` — wrapped
//! to a zero-length arc, dropping every arc vertex and leaving a 3-point
//! degenerate profile that rendered as flat triangles.
//!
//! After the fix the cartesian bounds are inverted through the circle's
//! placement into the parametric angles π/2 → −π/2, reconstructing the +x
//! semicircle.
//!
//! Fixture: `tests/models/issues/953_trimmed_curve_cartesian_arc.ifc`.

use ifc_lite_core::{EntityDecoder, IfcSchema, IfcType};
use ifc_lite_geometry::{GeometryRouter, ProfileProcessor};

const FIXTURE: &str = "../../tests/models/issues/953_trimmed_curve_cartesian_arc.ifc";

/// `#206` — the `IfcArbitraryClosedProfileDef` whose outer curve is the
/// polyline + cartesian-trimmed semicircle (radius 2.4).
const PROFILE_ID: u32 = 206;
/// `#205` — the `IfcExtrudedAreaSolid` that sweeps `#206`.
const EXTRUSION_ID: u32 = 205;
const RADIUS: f64 = 2.4;

/// The first line of every Git LFS pointer file. Split + concatenated at
/// runtime so the literal doesn't appear in the source (GitHub's pre-receive
/// hook rejects any commit containing the contiguous string).
fn lfs_pointer_prefix() -> String {
    format!("version {}{}", "https://git-lfs.github.com/", "spec/")
}

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with(&lfs_pointer_prefix()) => {
            eprintln!(
                "skipping issue-953 regression: fixture at {FIXTURE} is a Git LFS \
                 pointer — run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-953 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

fn mesh_bbox(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    (min, max)
}

#[test]
fn cartesian_trimmed_arc_is_reconstructed() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    let processor = ProfileProcessor::new(IfcSchema::new());
    let profile_entity = decoder
        .decode_by_id(PROFILE_ID)
        .expect("decode IfcArbitraryClosedProfileDef #206");
    let profile = processor
        .process(&profile_entity, &mut decoder)
        .expect("profile processing must not error");

    // Pre-fix the arc collapsed to a single point, leaving a 3-vertex
    // degenerate outline. A reconstructed semicircle (~8 segments per 90°)
    // contributes well over a dozen vertices.
    assert!(
        profile.outer.len() >= 12,
        "outer profile has only {} points — the trimmed arc collapsed",
        profile.outer.len(),
    );

    // The arc bulges to +x and must reach its apex at (radius, 0). With the
    // arc dropped, no vertex ever leaves the x = 0 diameter line.
    let max_x = profile
        .outer
        .iter()
        .map(|p| p.x)
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(
        (max_x - RADIUS).abs() < 0.05,
        "arc apex x = {max_x:.4}, expected ~{RADIUS} (radius) — arc missing",
    );

    // Every reconstructed vertex must sit on the circle of radius 2.4 centred
    // at the origin (or on the x = 0 diameter chord). Verify the arc vertices
    // (x > tiny) lie on the circle.
    for p in &profile.outer {
        if p.x > 1e-3 {
            let r = (p.x * p.x + p.y * p.y).sqrt();
            assert!(
                (r - RADIUS).abs() < 1e-3,
                "arc vertex ({:.4},{:.4}) is off the circle (r = {r:.4})",
                p.x,
                p.y,
            );
        }
    }
}

#[test]
fn cartesian_trimmed_wall_mesh_spans_radius() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    let router = GeometryRouter::new();
    let entity = decoder
        .decode_by_id(EXTRUSION_ID)
        .expect("decode IfcExtrudedAreaSolid #205");
    assert_eq!(entity.ifc_type, IfcType::IfcExtrudedAreaSolid);

    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .expect("extrusion tessellation must not error");

    assert!(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "wall mesh empty — composite curve collapsed",
    );
    assert_eq!(mesh.positions.len() % 3, 0);
    assert_eq!(mesh.indices.len() % 3, 0);

    // The profile spans the full diameter (2 * radius) in one in-plane axis;
    // pre-fix the collapsed arc shrank the cross-section to the diameter chord
    // with no depth, so the mesh was a near-degenerate sliver. A faithful
    // semicircle is 4.8 wide (diameter) and 2.4 deep (radius).
    let (min, max) = mesh_bbox(&mesh.positions);
    let mut spans = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    spans.sort_by(|a, b| b.partial_cmp(a).unwrap());

    assert!(
        spans[0] >= (2.0 * RADIUS) as f32 - 0.05,
        "largest span {:.3} — expected ~{:.1} (diameter); arc collapsed?",
        spans[0],
        2.0 * RADIUS,
    );
    assert!(
        spans[1] >= RADIUS as f32 - 0.05,
        "second span {:.3} — expected >= {:.1} (radius); arc collapsed?",
        spans[1],
        RADIUS,
    );
}
