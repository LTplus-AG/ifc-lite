// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #883 — `IfcGridPlacement` was not honoured by
//! the placement resolver, so every column laid out on a structural grid
//! fell back to identity placement and stacked at the world origin instead
//! of landing on its grid-axis intersection.
//!
//! The reporter's `ifcgrid.ifc` (IFC4X3_ADD2, millimetres) places 25
//! `IfcColumn`s via `IfcGridPlacement → IfcVirtualGridIntersection`. Two of
//! them share the same column line (grid axis 'E', a vertical line at
//! x = 3000) but sit on different rows:
//!   * #293 — axis 'E' × row '1' (y = -12000) → grid-local (3000, -12000)
//!   * #519 — axis 'E' × row '2' (y =  -8000) → grid-local (3000,  -8000)
//! Authored 4000 mm apart in Y. Because the grid's own placement is a rigid
//! transform, that 4000 mm separation is preserved in world space and, after
//! the mm→m unit scale, the two column centroids must be ≈ 4.0 m apart.
//!
//! Pre-fix both columns resolved to identity placement → identical world
//! geometry → centroid separation ≈ 0. The fix resolves
//! `IfcGridPlacement.PlacementLocation` by intersecting the two referenced
//! `IfcGridAxis` curves (composed with the grid's `PlacementRelTo`).
//!
//! The fixture is committed alongside this test (as `.ifc.txt` so it dodges
//! the `*.ifc` fixture-fetch gitignore) and embedded via `include_str!`, so
//! the regression runs in CI without the on-demand fixture store.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

const FIXTURE: &str = include_str!("fixtures/issue_883_grid_placement.ifc.txt");

/// Column on grid axis 'E' × row '1'.
const COLUMN_E1: u32 = 293;
/// Column on grid axis 'E' × row '2' (4000 mm from the E1 column in Y).
const COLUMN_E2: u32 = 519;

fn mesh_centroid(m: &Mesh) -> (f64, f64, f64) {
    let (lo, hi) = m.bounds();
    (
        ((lo.x + hi.x) * 0.5) as f64,
        ((lo.y + hi.y) * 0.5) as f64,
        ((lo.z + hi.z) * 0.5) as f64,
    )
}

#[test]
fn grid_placed_columns_land_on_their_intersections_not_at_origin() {
    let content = FIXTURE.to_string();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let c_e1 = decoder.decode_by_id(COLUMN_E1).expect("decode column #293");
    let c_e2 = decoder.decode_by_id(COLUMN_E2).expect("decode column #519");

    let m1 = router.process_element(&c_e1, &mut decoder).expect("mesh #293");
    let m2 = router.process_element(&c_e2, &mut decoder).expect("mesh #519");

    assert!(
        !m1.positions.is_empty() && !m2.positions.is_empty(),
        "both grid-placed columns must produce geometry",
    );

    let (x1, y1, _) = mesh_centroid(&m1);
    let (x2, y2, _) = mesh_centroid(&m2);
    let separation = ((x1 - x2).powi(2) + (y1 - y2).powi(2)).sqrt();

    // Core symptom guard: pre-fix both columns resolved to identity placement
    // and rendered at the same spot, so their centroids coincided.
    assert!(
        separation > 1.0,
        "Columns #293 and #519 are only {separation:.3} m apart — they have \
         collapsed onto the same position. IfcGridPlacement is falling back \
         to identity instead of resolving the grid-axis intersection.",
    );

    // Accuracy: authored 4000 mm row spacing → 4.0 m after the mm→m unit
    // scale. A rigid grid placement preserves the distance regardless of the
    // grid's own offset/rotation.
    assert!(
        (separation - 4.0).abs() < 0.5,
        "Columns #293 (axis E × row 1) and #519 (axis E × row 2) were \
         authored 4.0 m apart; measured {separation:.3} m. A wrong value \
         means the grid-axis intersection or its unit scaling is off.",
    );
}

#[test]
fn every_grid_placed_column_resolves_without_error() {
    // All 25 columns use IfcGridPlacement. Confirm the resolver handles each
    // without erroring (it previously never executed for this placement type).
    let content = FIXTURE.to_string();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let mut centroids: Vec<(f64, f64)> = Vec::new();
    let mut scanner = ifc_lite_core::EntityScanner::new(&content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if name != "IFCCOLUMN" {
            continue;
        }
        let col = decoder
            .decode_by_id(id)
            .unwrap_or_else(|e| panic!("decode column #{id}: {e:?}"));
        let mesh = router
            .process_element(&col, &mut decoder)
            .unwrap_or_else(|e| panic!("process column #{id}: {e:?}"));
        if !mesh.positions.is_empty() {
            let (lo, hi) = mesh.bounds();
            centroids.push((
                ((lo.x + hi.x) * 0.5) as f64,
                ((lo.y + hi.y) * 0.5) as f64,
            ));
        }
    }

    assert_eq!(centroids.len(), 25, "expected 25 grid-placed columns to mesh");

    // Not every column collapsed to one point: the spread of centroids must
    // span the grid (axes range over ~19 m in X and ~12 m in Y). Pre-fix the
    // x- and y-spreads were both ≈ 0.
    let xs = centroids.iter().map(|c| c.0);
    let ys = centroids.iter().map(|c| c.1);
    let x_spread = xs.clone().fold(f64::MIN, f64::max) - xs.fold(f64::MAX, f64::min);
    let y_spread = ys.clone().fold(f64::MIN, f64::max) - ys.fold(f64::MAX, f64::min);
    assert!(
        x_spread > 5.0 && y_spread > 5.0,
        "grid-placed columns barely spread (x={x_spread:.2} m, y={y_spread:.2} m) — \
         they are not being distributed across the grid intersections",
    );
}
