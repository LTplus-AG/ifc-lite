// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #820 — IFCTRIMMEDCURVE parameter values are in
//! the project's PLANEANGLEUNIT, not unconditionally degrees.
//!
//! The Renga-exported `RadianValuesOverPI.ifc` declares
//! `IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)` and authors its wall's outline
//! as two arcs whose trim parameters are radians > π:
//!
//! ```text
//! #2160 = IFCTRIMMEDCURVE(#2159,
//!     (IFCPARAMETERVALUE(5.759586531581289)),
//!     (IFCPARAMETERVALUE(9.948376736367674)),
//!     .T., .PARAMETER.);
//! ```
//!
//! Before the fix, `profiles.rs::process_trimmed_conic` called
//! `.to_radians()` on every parameter value. For a RADIAN file this
//! reinterprets 5.76 rad (~330°) as 5.76° and shrinks the 240° wall arc
//! to ~4°, collapsing the wall mesh to a sliver near the chord endpoints.
//!
//! After the fix the code reads PLANEANGLEUNIT from IFCUNITASSIGNMENT
//! (cached on EntityDecoder) and multiplies by the right factor — 1.0 for
//! RADIAN files, π/180 for DEGREE files.
//!
//! Fixture: `tests/models/issues/820_RadianValuesOverPI.ifc`.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/820_RadianValuesOverPI.ifc";

// `#2173 IFCEXTRUDEDAREASOLID` — the wall body. Its profile is
// `#2167 IFCARBITRARYCLOSEDPROFILEDEF` whose outer curve is the composite
// `#2166` of two trimmed circles + two polylines. Picked over the wrapping
// `#2176 IFCWALLSTANDARDCASE` because `process_representation_item` skips
// the wall's local-placement transform and lets us assert directly in the
// profile's own coordinate space (millimetres).
const EXTRUSION_ID: u32 = 2173;

/// The first line of every Git LFS pointer file. Split + concatenated at
/// runtime so the literal doesn't appear in the source — GitHub's
/// pre-receive hook treats any commit containing the contiguous string as
/// an LFS pointer file and rejects the push with `commit_refs error`.
fn lfs_pointer_prefix() -> String {
    format!("version {}{}", "https://git-lfs.github.com/", "spec/")
}

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with(&lfs_pointer_prefix()) => {
            // The fixture is a Git LFS pointer, not the real bytes — happens
            // on fresh clones before `pnpm fixtures` runs. Skip cleanly so
            // the misleading IFC-parse error on the pointer text never
            // bubbles up.
            eprintln!(
                "skipping issue-820 regression: fixture at {FIXTURE} is a Git LFS \
                 pointer — run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-820 regression: fixture missing at {FIXTURE} — \
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
            if chunk[axis] < min[axis] {
                min[axis] = chunk[axis];
            }
            if chunk[axis] > max[axis] {
                max[axis] = chunk[axis];
            }
        }
    }
    (min, max)
}

#[test]
fn trimmed_curve_honors_planeangleunit_radian() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    // Sanity: the decoder picks up RADIAN from the unit assignment (#9).
    let scale = decoder.plane_angle_to_radians();
    assert!(
        (scale - 1.0).abs() < 1e-9,
        "expected RADIAN scale = 1.0 for RadianValuesOverPI.ifc, got {}",
        scale,
    );

    let router = GeometryRouter::new();
    let entity = decoder
        .decode_by_id(EXTRUSION_ID)
        .expect("decode IfcExtrudedAreaSolid #2173");
    assert_eq!(entity.ifc_type, IfcType::IfcExtrudedAreaSolid);

    let mesh = router
        .process_representation_item(&entity, &mut decoder)
        .expect("extrusion tessellation must not error");

    assert!(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "wall mesh empty — composite curve probably collapsed",
    );
    assert_eq!(mesh.positions.len() % 3, 0);
    assert_eq!(mesh.indices.len() % 3, 0);

    let (min, max) = mesh_bbox(&mesh.positions);
    let span_x = max[0] - min[0];
    let span_y = max[1] - min[1];
    let span_z = max[2] - min[2];

    // Profile geometry: circle r=12000 mm centred at (0,-12000), arc swept
    // ~240° → footprint roughly 22000 × 18000 mm. Pre-fix the trimmed
    // circles collapsed and the profile shrank to a few mm cluster, so any
    // span > 15 m is unambiguously the post-fix state.
    assert!(
        span_x > 15_000.0,
        "wall X span {:.1} mm — expected > 15000 (arc collapsed?)",
        span_x,
    );
    assert!(
        span_y > 15_000.0,
        "wall Y span {:.1} mm — expected > 15000 (arc collapsed?)",
        span_y,
    );

    // Extrusion depth is 3000 mm — verifies the Z axis is still the
    // extrusion direction and didn't get tangled by the unit fix.
    assert!(
        (span_z - 3000.0).abs() < 50.0,
        "wall Z span {:.1} mm — expected ~3000 (extrusion depth)",
        span_z,
    );
}
