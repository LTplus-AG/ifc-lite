// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust review finding D11: `rect_boxes_processed` must mean one thing on
//! every cut path, because the silent-no-op detector gates on it.

use super::*;

fn recorded_rect_boxes(router: &GeometryRouter, id: u32) -> usize {
    router.take_host_opening_diagnostics()[&id].rect_boxes_processed
}

#[test]
fn prism_and_exact_paths_record_the_same_rect_box_count() {
    let host = GeometryRouter::make_box_mesh(
        Point3::new(-2.0, -0.15, -1.5),
        Point3::new(2.0, 0.15, 1.5),
    );
    // One non-rectangular (mesh) cutter and no rectangular opening at all.
    let (mn, mx) = (Point3::new(-0.5, -0.4, -0.5), Point3::new(0.5, 0.4, 0.5));
    let cutter = GeometryRouter::make_box_mesh(mn, mx);
    let openings = vec![OpeningType::NonRectangular(
        cutter,
        mn,
        mx,
        Some(Vector3::new(0.0, 1.0, 0.0)),
    )];
    let ctx = VoidContext { merged_openings: openings.clone(), openings, param: None, bool2d: None };

    assert!(prism_cut::enabled(), "IFC_LITE_PRISM_CUT=0 turns off the path this test pins");
    let prism = GeometryRouter::new();
    assert!(prism.try_prism_cut(&host, &ctx).is_some(), "premise: the box cutter takes the prism path");
    prism.apply_void_context(host.clone(), &ctx, 7);

    let exact = GeometryRouter::new();
    let bounds = world_host_bounds(&host);
    exact.apply_void_context_inner(host, &ctx, 7, bounds, false);

    let (on_prism, on_exact) = (recorded_rect_boxes(&prism, 7), recorded_rect_boxes(&exact, 7));
    assert_eq!(
        on_prism, on_exact,
        "the prism path recorded {on_prism} rect boxes, the exact path {on_exact}, for the same host"
    );
    assert_eq!(on_exact, 0, "a host with no rectangular opening processed no rect box");
}
