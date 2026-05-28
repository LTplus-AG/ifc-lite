// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #853 — an `IfcOpeningElement` authored as
//! a RECESS / POCKET (one face flush with the host's surface, opposite
//! face stopping inside the host) must NOT be promoted to a through-hole.
//!
//! Fixture: `tests/models/issues/853_slab_pocket.ifc`. One `IfcSlab`
//! at world z = -200…0 mm (200 mm thick) with two voids:
//!   * #325 — circular Ø100, full-thickness extrusion. THROUGH-hole.
//!   * #336 — rectangular 1000 × 500, 50 mm deep, top flush with the
//!     slab top (z = 0). Authored `PredefinedType = .RECESS.`
//!
//! Pre-fix, `extend_opening_along_direction` saw an opening that
//! "didn't reach the opposite wall face" and stretched it down to the
//! slab bottom — producing a through-hole where the user authored a
//! pocket.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const FIXTURE: &str = "../../tests/models/issues/853_slab_pocket.ifc";
const SLAB_ID: u32 = 303;

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("issue-853 fixture missing — skipping (run `pnpm fixtures`)");
            None
        }
        Err(e) => panic!("failed to read fixture: {e}"),
    }
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    use ifc_lite_core::EntityScanner;
    let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    idx.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut idx, content, &mut decoder);
    idx
}

fn bounds(m: &Mesh) -> ((f32, f32, f32), (f32, f32, f32)) {
    let (lo, hi) = m.bounds();
    ((lo.x, lo.y, lo.z), (hi.x, hi.y, hi.z))
}

#[test]
fn issue_853_recess_does_not_extend_through_slab() {
    let Some(content) = read_fixture() else { return };
    let ei = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, ei);
    let void_idx = build_void_index(&content);

    let slab = decoder.decode_by_id(SLAB_ID).expect("slab #303");
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let mesh = router
        .process_element_with_voids(&slab, &mut decoder, &void_idx)
        .expect("slab must mesh");

    // The recess is 50 mm deep at the top of the slab — its FLOOR is
    // the horizontal plane z = -0.050 m (in world). When the recess is
    // correctly treated as a pocket, CSG produces a triangle ring on
    // that floor (the cap of the pocket), so at least a few vertices
    // sit at z ≈ -0.05 m inside the recess's xy footprint
    // (x ∈ [0, 1] m, y ∈ [0.75, 1.25] m).
    //
    // When the recess is wrongly extended into a through-hole, the
    // floor disappears (the cut goes all the way through to z = -0.2)
    // and NO vertices sit at z ≈ -0.05. This is the load-bearing
    // assertion for issue #853.
    const FLOOR_Z: f32 = -0.050;
    const FLOOR_TOL: f32 = 0.002; // 2 mm
    let recess_xmin = 0.0_f32;
    let recess_xmax = 1.0_f32;
    let recess_ymin = 0.75_f32;
    let recess_ymax = 1.25_f32;

    let pocket_floor_verts: usize = mesh
        .positions
        .chunks_exact(3)
        .filter(|p| {
            (p[2] - FLOOR_Z).abs() < FLOOR_TOL
                && (recess_xmin..=recess_xmax).contains(&p[0])
                && (recess_ymin..=recess_ymax).contains(&p[1])
        })
        .count();

    assert!(
        pocket_floor_verts >= 4,
        "recess pocket floor missing (found {} verts at z ≈ -0.050 m \
         inside the recess footprint). The 50 mm pocket was extended \
         into a through-hole — issue #853.",
        pocket_floor_verts,
    );

    // Sanity: the slab still has its full extent in Z (the
    // through-hole opening #325 doesn't shrink the bbox; it carves
    // a hole through the interior). If the recess fix accidentally
    // killed all openings, the slab would still span correctly here,
    // but `pocket_floor_verts` above only succeeds if the recess
    // produced new floor geometry — so we're not testing the same
    // thing twice.
    let ((_xmin, _ymin, zmin), (_xmax, _ymax, zmax)) = bounds(&mesh);
    let slab_span_mm = (zmax - zmin) * 1000.0;
    assert!(
        slab_span_mm > 180.0,
        "slab span dropped to {:.1} mm — both openings cut wrong?",
        slab_span_mm,
    );
}
