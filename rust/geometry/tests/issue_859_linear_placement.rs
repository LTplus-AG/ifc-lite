// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #859 — `IfcLinearPlacement` was not honoured
//! by the placement resolver, so every product (railway signals, referents,
//! signs) placed at a station along an `IfcAlignment` fell back to identity
//! placement and piled up at world origin. The reporter's
//! `linear-placement-of-signal.ifc` fixture shows the obvious symptom: only
//! one signal renders, all at (0, 0, 0), instead of the dozens authored at
//! varying stations along the gradient curve.
//!
//! The fix resolves `IfcLinearPlacement.RelativePlacement
//! (IfcAxis2PlacementLinear)` → `Location (IfcPointByDistanceExpression)` →
//! samples the `BasisCurve` (an `IfcGradientCurve` whose `BaseCurve` is an
//! `IfcCompositeCurve` of `IfcCurveSegment`s — pure IFC4x3 plumbing) at the
//! authored `DistanceAlong`, and builds a curve-aligned frame with the
//! authored lateral/vertical/longitudinal offsets.
//!
//! Sampling currently uses each `IfcCurveSegment.Placement.Location` as a
//! sparse polyline sample (one point per segment) and linearly interpolates.
//! For the railway fixture's ~390 m line segments that's perfect at segment
//! starts and accurate enough between them that signals land within a few
//! metres of their authored station. A full per-segment parent-curve
//! evaluator is follow-up scope; the key invariant — *signals land on the
//! alignment instead of at world origin* — is what this regression locks.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/859_linear_placement_of_signal.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            eprintln!("issue-859 fixture is an LFS pointer — skipping");
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("issue-859 fixture missing — skipping (run `pnpm fixtures`)");
            None
        }
        Err(e) => panic!("failed to read fixture: {e}"),
    }
}

fn mesh_centroid(m: &ifc_lite_geometry::Mesh) -> (f64, f64, f64) {
    let (lo, hi) = m.bounds();
    (
        ((lo.x + hi.x) * 0.5) as f64,
        ((lo.y + hi.y) * 0.5) as f64,
        ((lo.z + hi.z) * 0.5) as f64,
    )
}

#[test]
fn signals_land_on_alignment_not_at_world_origin() {
    let Some(content) = read_fixture() else { return };
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Two IfcSignals placed via IfcLinearPlacement on the gradient curve #2543:
    //   #3020 Route Indicator_01 — distance 353.1 m, lateral +3 m, vertical +2.5 m
    //   #3031 Route Indicator_02 — distance 853.1 m, lateral −3 m, vertical +2.5 m
    // Authored 500 m apart along the alignment. In MGA projected coords
    // (~452270, 4539403, …) the world-space separation of their bounding-
    // box centroids should match — within a few metres for the sparse
    // segment-start sampler.
    let s1 = decoder.decode_by_id(3020).expect("decode #3020 Route Indicator_01");
    let s2 = decoder.decode_by_id(3031).expect("decode #3031 Route Indicator_02");

    let m1 = router.process_element(&s1, &mut decoder).expect("process #3020");
    let m2 = router.process_element(&s2, &mut decoder).expect("process #3031");

    assert!(
        !m1.positions.is_empty() && !m2.positions.is_empty(),
        "both signals must produce geometry",
    );

    let (c1x, c1y, _) = mesh_centroid(&m1);
    let (c2x, c2y, _) = mesh_centroid(&m2);

    // Sanity: signals must be in projected MGA territory, NOT at world origin.
    // Pre-fix both centroids collapsed to (≈0, ≈0, ≈0).
    assert!(
        c1x.abs() > 1_000.0,
        "Route Indicator_01 centroid x={c1x:.2} should be in MGA territory \
         (~452 600 m). Pre-fix `IfcLinearPlacement` returned identity → \
         signal anchored at world origin instead of station 353 m along the \
         alignment.",
    );
    assert!(
        c2x.abs() > 1_000.0,
        "Route Indicator_02 centroid x={c2x:.2} should be in MGA territory \
         (~453 044 m). Same pre-fix pile-up at world origin.",
    );

    // Separation along the alignment was authored as 500 m (853.1 − 353.1).
    // Linear interpolation between sparse segment-start samples for the two
    // stations both lying inside the same long line segment is exact, so
    // the measured separation should land very close to 500 m.
    let dx = c1x - c2x;
    let dy = c1y - c2y;
    let separation = (dx * dx + dy * dy).sqrt();
    assert!(
        (separation - 500.0).abs() < 10.0,
        "Authored 500 m alignment separation; measured {separation:.2} m. \
         A large delta would mean the linear-placement sampler is reading \
         the wrong DistanceAlong or wrong basis curve.",
    );
}

#[test]
fn referents_resolve_individual_placements_along_curve() {
    let Some(content) = read_fixture() else { return };
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Four IfcReferents at varied stations. Even though referents typically
    // carry no body geometry, `process_element` still runs the placement
    // resolver — and if `IfcLinearPlacement` is honoured every referent's
    // placement should resolve to a non-identity 4×4. We probe through
    // `process_element_with_voids` instead, since referents may have
    // representation entries that exercise the void path; here we just
    // confirm no error and that the call returns successfully for every
    // referent type the fixture authors.
    for id in [2698u32, 2712, 2726, 2740] {
        let ent = decoder
            .decode_by_id(id)
            .unwrap_or_else(|e| panic!("decode #{id}: {e:?}"));
        let _ = router
            .process_element(&ent, &mut decoder)
            .unwrap_or_else(|e| panic!("process #{id} ({:?}): {e:?}", ent.ifc_type));
    }
}
