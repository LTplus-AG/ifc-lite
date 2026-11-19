// SPDX-License-Identifier: MPL-2.0

//! Split-wall recess fixture adapted from #10346 for #10512.

#![cfg(feature = "csg_manifold_gate")]

mod voids_common;
#[path = "voids_common/split_wall.rs"]
mod split_wall;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use ifc_lite_geometry::GeometryRouter;
use split_wall::{analytic_volume, wall, Recess};
use voids_common::production::build_void_index_like_production;

#[test]
fn split_recess_from_a_kilometre_away() {
    let mut failures = Vec::new();
    for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
        for turn in [0.0, 90.0] {
            for step in 0..6 {
                let offset = 2.0 + 0.137 * f64::from(step);
                let content = wall([1000.0, 800.0], turn, offset, recess);
                let voids = build_void_index_like_production(&content);
                let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
                let entity = decoder.decode_by_id(100).unwrap();
                let mut router = GeometryRouter::with_scale(1.0);
                let rtc = router
                    .detect_rtc_offset_for_file(content.as_bytes(), &mut decoder)
                    .expect("the fixture has a usable placement")
                    .offset();
                assert_ne!(rtc, (0.0, 0.0, 0.0), "the far fixture must use RTC");
                router.set_rtc_offset(rtc);
                let mesh = router
                    .process_element_with_voids(&entity, &mut decoder, &voids)
                    .unwrap();

                let ledger =
                    EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
                let open = ledger.unbalanced().count();
                let delta = mesh_volume(&mesh) - analytic_volume();
                let cut_failures = router.take_csg_failures();
                if open != 0 || delta.abs() > 0.0005 || !cut_failures.is_empty() {
                    failures.push(format!(
                        "{recess:?} turn={turn} y={offset:.3}: {open} open edges, {:+.3} L volume delta, {cut_failures:?}",
                        delta * 1000.0
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
