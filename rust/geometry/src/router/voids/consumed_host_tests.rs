// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A host whose openings together cover it is consumed on every cut path: the
//! cut is empty and the host is marked consumed, so the element pipeline keeps
//! the empty result instead of re-rendering the host uncut. A partial cut and
//! an untouched host are not marked. Exposed when #7942 made the opening
//! merge exact: two prisms a rounding apart stopped merging into one cutter.

use super::*;

const ID: u32 = 7;

/// A 4 x 0.2 x 3 m wall, thickness along y.
fn wall() -> Mesh {
    GeometryRouter::make_box_mesh(Point3::new(-2.0, -0.1, 0.0), Point3::new(2.0, 0.1, 3.0))
}

fn rect(mn: [f64; 3], mx: [f64; 3]) -> OpeningType {
    OpeningType::Rectangular(
        Point3::new(mn[0], mn[1], mn[2]),
        Point3::new(mx[0], mx[1], mx[2]),
        Some(Vector3::y()),
    )
}

fn boxed(mn: [f64; 3], mx: [f64; 3]) -> OpeningType {
    let (mn, mx) = (Point3::new(mn[0], mn[1], mn[2]), Point3::new(mx[0], mx[1], mx[2]));
    OpeningType::NonRectangular(GeometryRouter::make_box_mesh(mn, mx), mn, mx, Some(Vector3::y()))
}

fn context(openings: Vec<OpeningType>, param: Option<ParamRectCut>) -> VoidContext {
    VoidContext {
        merged_openings: GeometryRouter::merge_rectangular_openings(&openings),
        openings,
        param,
        bool2d: None,
    }
}

/// A parametric box whose local z (its extrusion) is the wall's thickness
/// axis, world y; `half` is (run, height, thickness).
fn param_box(center: [f64; 3], half: [f64; 3]) -> RectParam {
    let r = Matrix3::from_columns(&[Vector3::x(), -Vector3::z(), Vector3::y()]);
    RectParam { r, center: Point3::new(center[0], center[1], center[2]), half }
}

/// Cut through the owned execution and report (volume left, consumed).
fn cut(ctx: &VoidContext) -> (f64, bool) {
    let router = GeometryRouter::new();
    let out = router.apply_void_context(wall(), ctx, ID);
    (crate::mesh_check::signed_volume(&out).abs(), router.host_consumed_by_void(ID))
}

const WALL_M3: f64 = 4.0 * 0.2 * 3.0;

#[test]
fn openings_that_cover_the_host_consume_it() {
    let tiled = vec![rect([-2.0, -0.1, 0.0], [0.0, 0.1, 3.0]), rect([0.0, -0.1, 0.0], [2.0, 0.1, 3.0])];
    let param = ParamRectCut {
        host: param_box([0.0, 0.0, 1.5], [2.0, 1.5, 0.1]),
        openings: vec![param_box([-1.0, 0.0, 1.5], [1.0, 1.5, 0.1]), param_box([1.0, 0.0, 1.5], [1.0, 1.5, 0.1])],
    };
    let cases = [
        // Two halves overlapping by 10 cm, so they cannot merge into one box:
        // the analytic rectangle path empties the wall.
        (
            "overlapping rectangles",
            context(
                vec![rect([-2.5, -0.3, -0.5], [0.05, 0.3, 3.5]), rect([-0.05, -0.4, -0.5], [2.5, 0.4, 3.5])],
                None,
            ),
        ),
        // Two prisms from one inner plane spanning the thickness, one a hair
        // longer, so the exact merge keeps them apart. Each is extended
        // through the wall, so the exact path's engulf test consumes it.
        (
            "stacked rectangles",
            context(
                vec![rect([-2.0, -0.1, 0.0], [2.0, 0.02, 3.0]), rect([-2.0, 0.02, 0.0], [2.000_001, 0.1, 3.0])],
                None,
            ),
        ),
        // The parametric path refuses an empty cut and defers; the path it
        // defers to consumes the host.
        ("parametric tiles", context(tiled, Some(param))),
        // The prism path refuses, the exact path cuts the first cutter, and
        // the second then engulfs what is left.
        (
            "overlapping mesh cutters",
            context(
                vec![boxed([-2.5, -0.3, -0.5], [0.05, 0.3, 3.5]), boxed([-0.05, -0.4, -0.5], [2.5, 0.4, 3.5])],
                None,
            ),
        ),
        ("one engulfing mesh cutter", context(vec![boxed([-2.5, -0.3, -0.5], [2.5, 0.3, 3.5])], None)),
    ];
    for (name, ctx) in cases {
        assert_eq!(cut(&ctx), (0.0, true), "{name}");
    }
}

#[test]
fn a_partial_cut_is_not_consumed() {
    for ctx in [
        context(vec![rect([-2.5, -0.3, -0.5], [0.0, 0.3, 3.5])], None),
        context(vec![boxed([-2.5, -0.3, -0.5], [0.0, 0.3, 3.5])], None),
    ] {
        let (volume, consumed) = cut(&ctx);
        assert!((volume - WALL_M3 / 2.0).abs() < 1e-5, "half the wall stays, got {volume}");
        assert!(!consumed);
    }
}

#[test]
fn a_host_its_openings_miss_is_not_consumed() {
    for ctx in [
        context(vec![rect([3.0, -0.3, 0.5], [4.0, 0.3, 1.5])], None),
        context(vec![boxed([3.0, -0.3, 0.5], [4.0, 0.3, 1.5])], None),
    ] {
        let (volume, consumed) = cut(&ctx);
        // The exact path re-triangulates the welded host; its f32 volume moves
        // by ~1e-4 m³ without any cut.
        assert!((volume - WALL_M3).abs() < 1e-3, "the whole wall stays, got {volume}");
        assert!(!consumed);
    }
}

// A thin web between two through-openings (#7942 stopped merging them) must
// survive the analytic cut closed: consolidation's size rules used to drop its
// rim faces and open the mesh. Both cellular-cut paths are exercised.

/// Half-gaps of 1, 2 and 3 snap-grid steps: `subtract_rect_openings` snaps
/// opening edges to `SNAP_GRID`, so only whole steps give distinct webs. The
/// webs are 2, 4 and 6 steps (about 31, 61 and 92 um), all under the old
/// 0.1 mm weld.
const WEB_GAPS: [f64; 3] = [crate::kernel::mesh_bridge::SNAP_GRID, 2.0 * crate::kernel::mesh_bridge::SNAP_GRID, 3.0 * crate::kernel::mesh_bridge::SNAP_GRID];

/// Wall of `WALL_M3`'s family, 6 x 0.2 x 3 m, cut by two full-height openings
/// `gap` either side of x = 0, so a web of 2 * `gap` remains.
fn web_wall() -> Mesh {
    GeometryRouter::make_box_mesh(Point3::new(-3.0, -0.1, 0.0), Point3::new(3.0, 0.1, 3.0))
}

fn web_boxes(gap: f64) -> Vec<([f64; 3], [f64; 3])> {
    vec![([-2.0, -0.3, -0.5], [-gap, 0.3, 3.5]), ([gap, -0.3, -0.5], [2.0, 0.3, 3.5])]
}

fn web_openings(gap: f64) -> Vec<OpeningType> {
    web_boxes(gap).into_iter().map(|(a, b)| rect(a, b)).collect()
}

#[test]
fn thin_residual_between_rect_openings_stays_closed() {
    for gap in WEB_GAPS {
        let ctx = context(web_openings(gap), None);
        assert_eq!(ctx.merged_openings.len(), 2, "the authored gap must survive the merge");
        let router = GeometryRouter::new();
        let out = router.apply_void_context(web_wall(), &ctx, 1);
        assert_eq!(router.take_rect_fast_stats().fired, 1, "gap {gap}: must come from rect_fast");
        let tris = out.indices.len() / 3;
        assert!(crate::exact_topology::strict_closed_mesh(&out), "gap {gap}: open cut ({tris} tris)");
    }
}

#[test]
fn thin_residual_between_param_openings_is_rejected_and_stays_closed() {
    for gap in WEB_GAPS {
        let hx = (2.0 - gap) / 2.0;
        let param = ParamRectCut {
            host: param_box([0.0, 0.0, 1.5], [3.0, 1.5, 0.1]),
            openings: vec![
                param_box([-(gap + hx), 0.0, 1.5], [hx, 1.5, 0.1]),
                param_box([gap + hx, 0.0, 1.5], [hx, 1.5, 0.1]),
            ],
        };
        let ctx = context(web_openings(gap), Some(param));
        // The parametric attempt is called directly, so IFC_LITE_RECT_PARAM and
        // IFC_LITE_RECT_FAST cannot skip it. Its torn cut fails the exact closure
        // self-check (the old 0.1 mm weld could not see it) and it defers.
        let router = GeometryRouter::new();
        assert!(router.try_param_rect_cut(&web_wall(), &ctx).is_none(), "gap {gap}: torn param cut emitted");
        assert_eq!(router.take_rect_fast_stats().fired, 0, "a rejected cut is not counted");
        // With rect_fast on, the pipeline falls back to it, which keeps the closed cut.
        let out = router.apply_void_context(web_wall(), &ctx, 1);
        assert_eq!(router.take_rect_fast_stats().fired, 1, "gap {gap}: fallback must come from rect_fast");
        let tris = out.indices.len() / 3;
        assert!(crate::exact_topology::strict_closed_mesh(&out), "gap {gap}: open cut ({tris} tris)");
    }
}
