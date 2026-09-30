// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use super::super::{VoidContext, coaxial_union, world_host_bounds};
use nalgebra::Point3;

// Process-global census/cap invariants must not race ordinary geometry tests,
// which do not acquire the budget-mutator lock before entering element scopes.
fn isolated_test(name: &str, marker: &str) -> bool {
    if std::env::var_os(marker).is_some() { return true; }
    let name = format!("{}::{name}", module_path!().split_once("::").unwrap().1);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"]).env(marker, "1")
        .output().expect("launch isolated geometry regression");
    assert!(output.status.success(), "{}\n{}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
        "the exact child selector must run the regression, not zero tests");
    false
}

fn tetra_host() -> Mesh {
    let mut host = Mesh::new();
    host.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.];
    host.normals = vec![0.; 12];
    host.indices = vec![0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    host
}

fn vertical_box(x0: f64, y0: f64, x1: f64, y1: f64) -> OpeningType {
    let min = Point3::new(x0, y0, -1.0);
    let max = Point3::new(x1, y1, 2.0);
    OpeningType::NonRectangular(GeometryRouter::make_box_mesh(min, max),
        min, max, Some(Vector3::new(0.0, 0.0, 1.0)))
}

fn cut(host: Mesh, openings: Vec<OpeningType>) -> Mesh {
    let context = VoidContext { merged_openings: openings.clone(), openings,
        param: None, bool2d: None };
    let bounds = world_host_bounds(&host);
    coaxial_union::set_enabled_override(Some(false));
    let result = GeometryRouter::new().apply_void_context_inner(
        host, &context, 6516, bounds, false);
    coaxial_union::set_enabled_override(None);
    result
}

fn jittered_opening(x: f32) -> OpeningType {
    let min = Point3::new(x as f64, -0.5, 0.2);
    let max = Point3::new(2.0, 0.5, 0.8);
    let mut mesh = GeometryRouter::make_box_mesh(min, max);
    // A separate face's copy of the same corner crosses one f32 ULP. The
    // 1 µm weld repairs this exporter-style seam using the first copy.
    let corner = mesh.positions[..3].to_vec();
    let duplicate = mesh.positions.chunks_exact(3).enumerate()
        .skip(1).find(|(_, p)| *p == corner.as_slice()).unwrap().0;
    mesh.positions[duplicate * 3] = x.next_down();
    OpeningType::NonRectangular(mesh, min, max, Some(Vector3::new(0.0, 1.0, 0.0)))
}

fn identity_guard(opening: &OpeningType) -> bool {
    let host = GeometryRouter::make_box_mesh(
        Point3::new(0.0, -0.15, 0.0), Point3::new(3.0, 0.15, 1.0));
    let (mesh, direction) = opening.mesh_cutter().unwrap();
    let cutter = GeometryRouter::batch_cutter(mesh, direction, &host)
        .expect("the admitted weld must restore a closed cutter");
    GeometryRouter::batch_cutters_match_sequential(&host, &[opening], &[(0, cutter)])
}

#[test]
fn harmless_weld_preserves_the_sequential_kernel_operand_6516() {
    assert!(identity_guard(&jittered_opening(1.0)),
        "a sub-snap seam repair preserves every ordered kernel triangle");
}

#[test]
fn weld_across_a_kernel_snap_boundary_keeps_sequential_fallback_6516() {
    let boundary = (1.0 + crate::kernel::mesh_bridge::SNAP_GRID * 0.5) as f32;
    assert!(!identity_guard(&jittered_opening(boundary)),
        "a closed welded cutter can differ from the raw cutter by a whole snap cell");
}

#[test]
fn conforming_disjoint_group_does_not_repeat_single_subtractions_6516() {
    // The always-on CSG census is process-global. Run this work-count invariant
    // alone in a child test process so unrelated parallel geometry cannot
    // contribute records; this also tests the default, counter-feature-off build.
    if !isolated_test("conforming_disjoint_group_does_not_repeat_single_subtractions_6516",
        "IFC_LITE_6516_BATCH_MISS_CHILD") { return; }
    // Tetrahedron x+y+z <= 1 is not a prism. Both boxes overlap its AABB,
    // but x+y > 1 keeps their entire solids outside it. Their AABBs are
    // disjoint from one another, so the actual router admits one group.
    let host = tetra_host().subdivided(1);
    let openings = vec![vertical_box(0.6, 0.6, 0.8, 0.8), vertical_box(0.85, 0.3, 0.95, 0.4)];
    crate::csg::take_csg_census();
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::take();
    let result = cut(host.clone(), openings);
    let census = crate::csg::take_csg_census();
    assert_eq!(census.len(), 1, "a conforming miss needs one group operation, not two more singles");
    #[cfg(feature = "opening-perf-trace")]
    {
        let counts = crate::opening_perf_trace::take();
        assert_eq!(counts.group_subtract_calls, 1, "must exercise actual group routing");
        assert_eq!(counts.batch_conforming_misses, 1);
        assert_eq!(counts.single_subtract_calls, 0, "proven miss must not repeat work");
    }
    assert!(super::super::prism_cut::closure_checks::closed_enough_to_emit(&result));
    assert!((super::super::geom::mesh_signed_volume(&result).abs() - 1.0 / 6.0).abs() < 1e-8,
        "consolidating the miss preserves the tetrahedron's solid");
    assert!(super::super::geom::point_inside_mesh(&result, Point3::new(0.1, 0.1, 0.1)));
    assert!(!super::super::geom::point_inside_mesh(&result, Point3::new(0.6, 0.6, 0.1)));
}

#[test]
fn retained_group_retessellation_preserves_a_later_real_cut_6516() {
    use crate::csg::{ClippingProcessor, GroupCut};
    use super::super::geom::{mesh_signed_volume, point_inside_mesh};
    use super::super::prism_cut::closure_checks::{closed_enough_to_emit, edge_multiplicity_defects};
    // One subdivision permits consolidation under the router's existing
    // quarter-triangle retention floor. Deeper simplification keeps fallback.
    let host = tetra_host().subdivided(1);
    let miss = vertical_box(0.6, 0.6, 0.8, 0.8);
    let miss_mesh = miss.mesh_cutter().unwrap().0;
    let GroupCut::Retessellated(retessellated) = ClippingProcessor::new().subtract_mesh(&host, miss_mesh) else {
        panic!("fixture must expose a real single-cutter retessellation");
    };
    assert_ne!(retessellated.triangle_count(), host.triangle_count(),
        "the old miss changes host topology before later cutters");
    // This genuine cutter overlaps the first miss's AABB, so it cannot join
    // that disjoint batch. It runs afterward on the retained group result.
    let actual = vertical_box(0.125, 0.125, 0.625, 0.625);
    let reference = cut(host.clone(), vec![actual.clone()]);
    // Exact-bit cutter admission is stricter than the canonical emitted-mesh
    // audit. Require the existing emit contract for both the direct reference
    // and the candidate, rather than assume exact-bit closure of all outputs.
    assert!(closed_enough_to_emit(&reference), "the direct cut must pass the existing emit audit");
    #[cfg(feature = "opening-perf-trace")]
    crate::opening_perf_trace::take();
    let result = cut(host.clone(), vec![miss, vertical_box(0.85, 0.3, 0.95, 0.4), actual]);
    #[cfg(feature = "opening-perf-trace")]
    {
        let counts = crate::opening_perf_trace::take();
        assert_eq!(counts.batch_conforming_misses, 1);
        assert_eq!(counts.single_subtract_calls, 1, "only the genuine cutter runs singly");
    }
    assert!(closed_enough_to_emit(&result), "the later cut must retain emitted closure");
    assert!(edge_multiplicity_defects(&result).is_clean(), "no duplicated or mis-wound faces");
    assert!(mesh_signed_volume(&result).abs() < mesh_signed_volume(&host).abs() - 0.01);
    assert!((mesh_signed_volume(&result) - mesh_signed_volume(&reference)).abs() < 1e-8,
        "skipping the misses must retain the genuine cutter's removed solid");
    let expected = 13.0 / 128.0;
    assert!((mesh_signed_volume(&result).abs() - expected).abs() < 1e-8,
        "integrating z=1-x-y outside the [1/8,5/8]^2 column leaves 13/128");
    // Test spatial occupancy as well as volume: equal volume alone could hide
    // a misplaced cut. All probes are strictly away from either boundary.
    for point in [Point3::new(0.25, 0.25, 0.25), Point3::new(0.5, 0.25, 0.125),
        Point3::new(0.25, 0.5, 0.125)] {
        assert!(point_inside_mesh(&host, point));
        assert!(!point_inside_mesh(&reference, point));
        assert!(!point_inside_mesh(&result, point), "the opening must remove {point:?}");
    }
    for point in [Point3::new(0.0625, 0.0625, 0.0625), Point3::new(0.75, 0.0625, 0.0625)] {
        assert!(point_inside_mesh(&reference, point));
        assert!(point_inside_mesh(&result, point), "the retained solid must contain {point:?}");
    }
}

#[cfg(feature = "opening-perf-trace")]
#[test]
fn same_count_group_miss_keeps_the_single_miss_cleanup_contract_6516() {
    let host = tetra_host();
    crate::opening_perf_trace::take();
    let result = cut(host.clone(), vec![vertical_box(0.6, 0.6, 0.8, 0.8),
        vertical_box(0.85, 0.3, 0.95, 0.4)]);
    let counts = crate::opening_perf_trace::take();
    assert_eq!(counts.batch_conforming_misses, 1);
    assert_eq!(counts.single_subtract_calls, 2,
        "a same-count group miss must keep the established single-miss path");
    assert_eq!(result.positions, host.positions);
    assert_eq!(result.indices, host.indices);
    assert_eq!(result.normals, host.normals,
        "discarded same-count misses must not replace the host or trigger new cleanup");
}

#[cfg(feature = "opening-perf-trace")]
#[test]
fn over_simplified_group_miss_keeps_the_retention_floor_fallback_6516() {
    use super::super::geom::{mesh_signed_volume, point_inside_mesh};
    let host = tetra_host().subdivided(2);
    assert_eq!(host.triangle_count(), 64);
    crate::opening_perf_trace::take();
    let result = cut(host, vec![vertical_box(0.6, 0.6, 0.8, 0.8),
        vertical_box(0.85, 0.3, 0.95, 0.4), vertical_box(0.125, 0.125, 0.625, 0.625)]);
    let counts = crate::opening_perf_trace::take();
    assert_eq!(counts.batch_conforming_misses, 1);
    assert_eq!(counts.single_subtract_calls, 3,
        "consolidating 64 host triangles to 4 must retain the existing quarter-count floor");
    assert!((mesh_signed_volume(&result).abs() - 13.0 / 128.0).abs() < 1e-8,
        "fallback must still perform the later genuine cut");
    assert!(!point_inside_mesh(&result, Point3::new(0.25, 0.25, 0.25)));
    assert!(point_inside_mesh(&result, Point3::new(0.0625, 0.0625, 0.0625)));
}

#[cfg(feature = "opening-perf-trace")]
#[test]
fn exhausted_element_budget_does_not_turn_a_group_into_a_proven_miss_6516() {
    if !isolated_test("exhausted_element_budget_does_not_turn_a_group_into_a_proven_miss_6516",
        "IFC_LITE_6516_ELEMENT_CAP_CHILD") { return; }
    use crate::kernel::budget;
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    struct RestoreElementCap(Option<u64>);
    impl Drop for RestoreElementCap {
        fn drop(&mut self) { budget::set_element_cap(self.0); }
    }
    let _restore = RestoreElementCap(budget::element_cap());
    // The child owns its global cap; ElementScope additionally restores this
    // thread's counters/caps on exit.
    budget::set_element_cap(Some(1));
    let _scope = budget::enter_element();
    let host = tetra_host().subdivided(2);
    let actual = vertical_box(0.125, 0.125, 0.625, 0.625);
    let outcome = crate::csg::ClippingProcessor::new()
        .subtract_mesh(&host, actual.mesh_cutter().unwrap().0);
    assert!(matches!(outcome, crate::csg::GroupCut::Rejected(crate::csg::GroupReject::BudgetTripped)),
        "real prior element work must exhaust the cap");
    crate::opening_perf_trace::take();
    let _ = cut(host, vec![vertical_box(0.6, 0.6, 0.8, 0.8),
        vertical_box(0.85, 0.3, 0.95, 0.4), actual]);
    let counts = crate::opening_perf_trace::take();
    assert_eq!(counts.group_rejections[2], 1, "group must report the trip");
    assert_eq!(counts.single_subtract_calls, 3, "a tripped group retains every member's fallback");
    assert!(budget::tripped(), "later begin calls must not reset the element budget");
}
