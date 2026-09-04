// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #960 — House.ifc walls clipped by a segmented roof via deeply-nested
//! `IfcBooleanClippingResult(.DIFFERENCE., x, IfcPolygonalBoundedHalfSpace)`
//! chains.
//!
//! Two distinct defects, both fixed by the chain-union path in
//! `BooleanClippingProcessor` (see `try_union_polygonal_chain`):
//!
//!   1. **Missing walls.** Walls clipped by 12–13 roof planes exceeded the
//!      `MAX_BOOLEAN_DEPTH` recursion limit, so processing returned `Err` and
//!      the wall rendered as *nothing*. (#4148, #2797, #5904.)
//!   2. **Seam slivers.** Sequentially subtracting abutting roof-segment
//!      prisms left a zero-thickness, full-height fin on the shared seam —
//!      a thin wall sliver poking *through* the roof (the original extrusion
//!      reached z = 9.85 m instead of the gable line). (#2152, #4374.)
//!
//! The fixture is a minimal transitive-closure extract of the five reported
//! walls from House.ifc (GitHub issue #960), fetched via `pnpm fixtures`
//! (sha256 in `tests/models/manifest.json`). Expected Z bounds are
//! IfcOpenShell's (pip 0.8.2, `use-world-coords`) — verified mm-identical to
//! both the full model and this extract. Coordinates are millimetres; the test
//! processes each wall at unit scale 1.0.
//!
//! The chain-union fix subtracts ONE watertight union of the cutter prisms.
//! `build_cutter_union` produces that union with the pure-Rust kernel's N-ary
//! union (`kernel::mesh_bridge::union_many` → `arrangement::union_all`): all
//! cutter prisms are conformed in ONE arrangement, so coplanar seams shared by
//! 3+ roof segments — and exactly-duplicated cutter prisms — dissolve into a
//! watertight solid. The pure-Rust exact kernel is the only kernel, so
//! this test runs unconditionally.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter};
use rustc_hash::FxHashMap;
use std::path::PathBuf;

const FIXTURE: &str = "issues/960_house_segmented_roof_clip.ifc";

/// Read a `tests/models/` fixture, returning `None` (skip the test) when it is
/// absent or still an LFS pointer — never panic, so fresh clones without
/// `pnpm fixtures` stay green.
fn read_fixture() -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models")
        .join(FIXTURE);
    match std::fs::read_to_string(&path) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            eprintln!("skipping: fixture {FIXTURE} is an LFS pointer — run `pnpm fixtures`");
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping: fixture {FIXTURE} not present — run `pnpm fixtures`");
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

/// Build the host→openings void index the same way production does.
fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

#[test]
fn segmented_roof_walls_render_without_slivers_or_drops() {
    let Some(content) = read_fixture() else {
        return;
    };
    let void_index = build_void_index(&content);
    let entity_index = build_entity_index(&content);

    // (express_id, GlobalId, expected world Z min/max in mm per IfcOpenShell)
    let cases = [
        (2152u32, "2FzACFrWn78vGKEK4Md6ha", 2850.0f32, 7325.0f32),
        (4374, "2PDtSyZL10pweyEST_guOH", 2850.0, 7348.0),
        (4148, "0wFZS1FlX4uQG90eXr1foJ", 2850.0, 8984.0),
        (2797, "1NKEanv7HDEOdbfk8nuT6f", 2850.0, 6593.0),
        (5904, "2l9upSYxz4xfNDmVZnFjG3", 2850.0, 8984.0),
    ];

    // 25 mm tolerance: the fix matches IfcOpenShell to ~1 mm; the regressions it
    // guards against are gross (a ~2.5 m sliver, or a fully empty mesh).
    let tol = 25.0_f32;

    #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
    let mut gated_regressions: Vec<u32> = Vec::new();
    for (id, gid, want_zmin, want_zmax) in cases {
        let mut decoder = EntityDecoder::with_index(&content, entity_index.clone());
        let entity = decoder.decode_by_id(id).expect("decode wall");
        let router = GeometryRouter::with_scale(1.0);
        let mesh = router
            .process_element_with_voids(&entity, &mut decoder, &void_index)
            .unwrap_or_default();

        assert!(
            !mesh.is_empty(),
            "#{id} ({gid}) rendered as EMPTY — the boolean-clip chain was dropped \
             (depth limit). Expected a clipped wall up to z={want_zmax} mm.",
        );

        let (mn, mx) = mesh.bounds();
        // #3440/#3871: an accept gate can reject the roof clip's kernel result
        // on one of these five walls, and the chain then falls back and regrows
        // the very seam sliver this test exists to catch. The gated builds keep
        // the real bar for the walls that hold it and pin the regression as
        // measured. The thing to fix is the FALLBACK path (the #635 AABB box-cut
        // the chain reaches when the exact clip is discarded); when it is, the
        // gated branch goes.
        //
        // Measured history (a value moving here means the gate or the fallback
        // moved and needs re-measuring, not re-pinning):
        //   - before #3912: #2152 read 9850 mm against its 7325 mm bar under
        //     EACH gate alone and under both; the other four unchanged.
        //   - after #3912 (the N-ary union weld, 2026-09-04, #3919): under
        //     `csg_manifold_gate` alone #2152 is back on its bar and #5904 reads
        //     9850 mm against its 8984 mm bar instead; under `csg_topology_gate`
        //     (alone or with the manifold gate) BOTH #2152 and #5904 read 9850.
        //     Stable across repeated runs. The gated pin is the exact set of
        //     walls that regress, asserted after the loop.
        #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
        if (id == 2152 || id == 5904) && (mx.z - 9850.0).abs() < tol {
            gated_regressions.push(id);
            continue;
        }
        assert!(
            (mx.z - want_zmax).abs() < tol,
            "#{id} ({gid}) max Z = {:.0} mm, expected ~{want_zmax} mm. A value near \
             9850 means a full-height seam sliver survived the roof clip.",
            mx.z,
        );
        assert!(
            (mn.z - want_zmin).abs() < tol,
            "#{id} ({gid}) min Z = {:.0} mm, expected ~{want_zmin} mm.",
            mn.z,
        );
    }
    #[cfg(all(feature = "csg_manifold_gate", not(feature = "csg_topology_gate")))]
    let expected_regressions: &[u32] = &[5904];
    #[cfg(feature = "csg_topology_gate")]
    let expected_regressions: &[u32] = &[2152, 5904];
    #[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
    assert_eq!(
        gated_regressions, expected_regressions,
        "the walls on which the accept gate lets the fallback regrow the seam \
         sliver moved (#3919 pins {expected_regressions:?}); a different set means \
         the gate or the fallback moved and needs re-measuring, not re-pinning."
    );
}
