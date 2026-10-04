// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Scan outline tracing (#6871) on deterministic synthetic slabs.
//!
//! Invariants asserted on every run (`assert_valid`, brute force): rings are
//! closed and simple, no two rings touch or cross, outer rings wind CCW and
//! holes CW, and each ring's innermost container is its recorded parent.
//! Scene-specific checks add the ring/vertex counts, the distance of every
//! vertex to the true wall surfaces, and squaring against the true direction.

use super::synth_tests::{assert_edges_squared, assert_valid, assert_vertices_on_walls, room_walls, Rng, SampleSpec, Scene};
use super::*;

/// Vertex tolerance against the true surfaces: noise is 3 mm; the corner
/// vertices come from intersecting fitted lines.
const VERTEX_TOL: f64 = 0.015;

fn run(scene: &Scene, spec: &SampleSpec, opts: &ScanOutlineOptions) -> ScanOutline {
    let pts = scene.sample(spec);
    let outline = trace_scan_outline(&pts, opts).expect("valid options");
    assert_valid(&outline);
    outline
}

/// The dominant direction is found within 0.3° of the truth and every edge
/// longer than 10 cm is squared to it exactly (up to rounding).
fn assert_squared_to(o: &ScanOutline, truth_deg: f64) {
    let dom = o.diagnostics.dominant_angle_deg.expect("a dominant direction");
    let err = (dom - truth_deg + 45.0).rem_euclid(90.0) - 45.0;
    assert!(err.abs() < 0.3, "dominant {dom}° vs {truth_deg}°");
    assert_edges_squared(o, dom, 0.1, 1e-6);
}

fn ring_sizes(o: &ScanOutline) -> Vec<usize> {
    o.rings.iter().map(Vec::len).collect()
}

#[test]
fn rectangular_room_gives_one_outer_and_one_hole_with_four_corners_each() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2));
    let o = run(&scene, &SampleSpec::default(), &ScanOutlineOptions::default());
    assert_eq!(o.shape_offsets, vec![0]);
    assert_eq!(ring_sizes(&o), vec![4, 4]);
    assert_eq!(o.parents, vec![None, Some(0)]);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
    assert_squared_to(&o, 0.0);
    // The hole is the room: 6 m × 4 m.
    let room = polygon_area(&o.rings[1]).abs();
    assert!((room - 24.0).abs() < 0.15, "room area {room}");
    let d = &o.diagnostics;
    assert_eq!((d.ring_count, d.outer_ring_count, d.hole_ring_count), (2, 1, 1));
    assert!(!d.cell_cap_hit);
    assert!(d.snapped_edges >= 8, "every wall face refitted, got {}", d.snapped_edges);
}

#[test]
fn l_shaped_building_keeps_its_reflex_corner() {
    let t = 0.2;
    let scene = Scene::new(vec![
        [-t, -t, 6.0 + t, 0.0],
        [6.0, 0.0, 6.0 + t, 3.0 + t],
        [3.0, 3.0, 6.0 + t, 3.0 + t],
        [3.0, 3.0, 3.0 + t, 6.0 + t],
        [-t, 6.0, 3.0 + t, 6.0 + t],
        [-t, -t, 0.0, 6.0 + t],
    ]);
    let o = run(&scene, &SampleSpec::default(), &ScanOutlineOptions::default());
    assert_eq!(ring_sizes(&o), vec![6, 6]);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
    assert_squared_to(&o, 0.0);
}

#[test]
fn two_rooms_sharing_a_wall_are_two_holes_in_one_outline() {
    let t = 0.2;
    let mut rects = room_walls(0.0, 0.0, 8.0, 4.0, t);
    rects.push([4.0, 0.0, 4.0 + t, 4.0]);
    let scene = Scene::new(rects);
    let o = run(&scene, &SampleSpec::default(), &ScanOutlineOptions::default());
    assert_eq!(o.shape_offsets, vec![0]);
    assert_eq!(ring_sizes(&o), vec![4, 4, 4]);
    assert_eq!(o.parents, vec![None, Some(0), Some(0)]);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
}

/// A wall with a gap: `gap` metres missing from the middle of the south wall.
fn room_with_gap(gap: f64) -> Scene {
    let t = 0.2;
    let mut rects = room_walls(0.0, 0.0, 6.0, 4.0, t);
    rects.remove(0);
    let mid = 3.0;
    rects.push([-t, -t, mid - gap / 2.0, 0.0]);
    rects.push([mid + gap / 2.0, -t, 6.0 + t, 0.0]);
    Scene::new(rects)
}

#[test]
fn an_opening_narrower_than_the_bridge_distance_is_closed() {
    let opts = ScanOutlineOptions { max_gap: 0.4, ..Default::default() };
    let scene = room_with_gap(0.2);
    let o = run(&scene, &SampleSpec::default(), &opts);
    assert_eq!(o.diagnostics.hole_ring_count, 1, "the room is still enclosed");
    assert_eq!(ring_sizes(&o), vec![4, 4]);
}

#[test]
fn an_opening_wider_than_the_bridge_distance_stays_open() {
    let opts = ScanOutlineOptions { max_gap: 0.4, ..Default::default() };
    let scene = room_with_gap(1.0);
    let o = run(&scene, &SampleSpec::default(), &opts);
    assert_eq!(o.diagnostics.hole_ring_count, 0, "the room opens to the outside");
    assert_eq!(o.rings.len(), 1);
    // A C-shape: the outline runs into the room through the door.
    assert_eq!(o.rings[0].len(), 12);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
    assert_squared_to(&o, 0.0);
}

#[test]
fn a_rotated_building_is_squared_to_its_own_direction() {
    let t = 0.2;
    let mut rects = room_walls(0.0, 0.0, 8.0, 5.0, t);
    rects.push([4.0, 0.0, 4.0 + t, 5.0]);
    let scene = Scene::new(rects).placed(23.0, [104.5, -37.25]);
    let o = run(&scene, &SampleSpec::default(), &ScanOutlineOptions::default());
    assert_eq!(ring_sizes(&o), vec![4, 4, 4]);
    assert_squared_to(&o, 23.0);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
}

#[test]
fn without_squaring_a_rotated_building_is_still_within_tolerance() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2)).placed(23.0, [0.0, 0.0]);
    let opts = ScanOutlineOptions { square: false, ..Default::default() };
    let o = run(&scene, &SampleSpec::default(), &opts);
    assert_eq!(ring_sizes(&o), vec![4, 4]);
    assert_eq!(o.diagnostics.squared_edges, 0);
    // Fitted lines alone already run within half a degree of the walls.
    assert_edges_squared(&o, 23.0, 1.0, 0.5);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
}

#[test]
fn noise_clutter_and_far_outliers_do_not_change_the_outline() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2)).placed(-11.0, [5.0, 5.0]);
    let spec = SampleSpec { sigma: 0.006, clutter_fraction: 0.01, far_outliers: 25, seed: 7, ..Default::default() };
    let o = run(&scene, &spec, &ScanOutlineOptions::default());
    assert_eq!(ring_sizes(&o), vec![4, 4]);
    assert_eq!(o.diagnostics.outlier_points, 25, "far outliers are excluded from the grid");
    assert!(o.diagnostics.cell_size <= 0.05);
    assert_vertices_on_walls(&o, &scene, 0.025);
}

#[test]
fn empty_and_degenerate_inputs_give_an_empty_or_valid_outline() {
    let opts = ScanOutlineOptions::default();
    let empty = trace_scan_outline(&[], &opts).unwrap();
    assert!(empty.rings.is_empty());
    let nan = trace_scan_outline(&[f32::NAN, 1.0, 2.0, f32::INFINITY], &opts).unwrap();
    assert!(nan.rings.is_empty());
    assert_eq!(nan.diagnostics.non_finite_points, 2);
    let single = trace_scan_outline(&[1.0, 2.0], &opts).unwrap();
    assert!(single.rings.is_empty(), "one point is below the component area");
    let odd = trace_scan_outline(&[1.0, 2.0, 3.0], &opts).unwrap();
    assert_eq!(odd.diagnostics.input_points, 1);
    // All points on one spot, and all on one line.
    let spot: Vec<f32> = (0..1000).flat_map(|_| [3.0f32, 4.0]).collect();
    assert_valid(&trace_scan_outline(&spot, &opts).unwrap());
    let line: Vec<f32> = (0..5000).flat_map(|i| [i as f32 * 0.001, 0.0]).collect();
    let o = trace_scan_outline(&line, &opts).unwrap();
    assert_valid(&o);
}

#[test]
fn the_cell_cap_coarsens_the_grid_and_says_so() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2));
    let pts = scene.sample(&SampleSpec::default());
    let opts = ScanOutlineOptions { cell_size: Some(0.01), max_cells: 20_000, ..Default::default() };
    let o = trace_scan_outline(&pts, &opts).unwrap();
    assert_valid(&o);
    let d = &o.diagnostics;
    assert!(d.cell_cap_hit);
    assert!(d.grid_width * d.grid_height <= 20_000);
    assert!(d.cell_size > 0.01);
}

#[test]
fn invalid_options_are_refused_and_an_oversized_gap_is_clamped() {
    let bad = [
        ScanOutlineOptions { cell_size: Some(0.0), ..Default::default() },
        ScanOutlineOptions { max_gap: f64::NAN, ..Default::default() },
        ScanOutlineOptions { min_cell_size: 0.1, max_cell_size: 0.05, ..Default::default() },
        ScanOutlineOptions { square_angle_tolerance_deg: 45.0, ..Default::default() },
        ScanOutlineOptions { max_cells: 3, ..Default::default() },
    ];
    for opts in bad {
        assert!(trace_scan_outline(&[0.0, 0.0], &opts).is_err(), "{opts:?}");
    }
    let wide = ScanOutlineOptions { max_gap: 2.0, ..Default::default() };
    let o = trace_scan_outline(&[0.0, 0.0], &wide).unwrap();
    assert!(o.diagnostics.max_gap_clamped);
}

#[test]
fn islands_inside_rooms_nest_under_their_hole() {
    // A free-standing 0.6 m column in the middle of the room.
    let mut rects = room_walls(0.0, 0.0, 6.0, 4.0, 0.2);
    rects.push([2.7, 1.7, 3.3, 2.3]);
    let scene = Scene::new(rects);
    let o = run(&scene, &SampleSpec::default(), &ScanOutlineOptions::default());
    assert_eq!(o.shape_offsets, vec![0, 2]);
    assert_eq!(o.parents, vec![None, Some(0), Some(1)]);
    assert_vertices_on_walls(&o, &scene, VERTEX_TOL);
}

#[test]
fn world_rings_map_plane_points_through_the_frame() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2));
    let o = run(&scene, &SampleSpec::default(), &ScanOutlineOptions::default());
    // A vertical section plane: u along world X, v along world Z (up).
    let frame = PlaneFrame { origin: [10.0, 20.0, 30.0], u_axis: [1.0, 0.0, 0.0], v_axis: [0.0, 0.0, 1.0] };
    let world = o.world_rings(&frame);
    for (ring, wring) in o.rings.iter().zip(&world) {
        for (p, w) in ring.iter().zip(wring) {
            assert_eq!(*w, [10.0 + p[0], 20.0, 30.0 + p[1]]);
        }
    }
}

/// Random rectilinear floor plans at random angles and densities: whatever the
/// stages do, the ring set stays valid.
#[test]
fn random_plans_always_give_valid_ring_sets() {
    for seed in 0..32u64 {
        let mut rng = Rng::new(seed);
        let t = 0.1 + rng.unit() * 0.2;
        let (w, h) = (4.0 + rng.unit() * 8.0, 3.0 + rng.unit() * 6.0);
        let mut rects = room_walls(0.0, 0.0, w, h, t);
        for _ in 0..(rng.next_u64() % 4) {
            let x = 1.0 + rng.unit() * (w - 2.0);
            let y0 = rng.unit() * h * 0.5;
            rects.push([x, y0, x + t, y0 + 1.0 + rng.unit() * h * 0.5]);
        }
        for _ in 0..(rng.next_u64() % 3) {
            let (x, y) = (rng.unit() * w, rng.unit() * h);
            let s = 0.1 + rng.unit() * 0.5;
            rects.push([x, y, x + s, y + s * (0.5 + rng.unit())]);
        }
        let scene = Scene::new(rects).placed(rng.unit() * 90.0, [rng.unit() * 50.0, rng.unit() * 50.0]);
        let spec = SampleSpec {
            per_metre: 60.0 + rng.unit() * 400.0,
            sigma: 0.002 + rng.unit() * 0.01,
            clutter_fraction: rng.unit() * 0.02,
            seed,
            ..Default::default()
        };
        run(&scene, &spec, &ScanOutlineOptions::default());
    }
}

/// Douglas-Peucker alone would drop the notch and swallow the small ring that
/// sits in it; the repair must put the notch back.
#[test]
fn simplification_reinserts_vertices_instead_of_swallowing_a_neighbour() {
    let a = vec![
        [0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [6.0, 10.0], [6.0, 9.0], [4.0, 9.0], [4.0, 10.0], [0.0, 10.0],
    ];
    let inside_notch = vec![[4.5, 9.3], [5.5, 9.3], [5.5, 9.7], [4.5, 9.7]];
    let crossing_notch = vec![[4.5, 9.5], [5.5, 9.5], [5.5, 10.5], [4.5, 10.5]];
    for b in [inside_notch, crossing_notch] {
        let rings = vec![a.clone(), b];
        let parents = vec![None, None];
        let (out, reinserted) = simplify::simplify_rings(&rings, &parents, 1.5);
        assert!(reinserted > 0);
        let expect_outer = vec![true, true];
        assert!(topology::find_violations(&out, &parents, &expect_outer).is_empty());
        assert!(out[0].contains(&[6.0, 9.0]) || out[0].contains(&[4.0, 9.0]), "notch restored: {:?}", out[0]);
    }
}

#[test]
fn a_move_that_crosses_another_ring_is_reverted() {
    let before = vec![
        vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]],
        vec![[5.0, 0.0], [9.0, 0.0], [9.0, 4.0], [5.0, 4.0]],
    ];
    let mut moved = before.clone();
    moved[0][1] = [6.0, 0.5]; // pokes into the second square
    moved[1][2] = [9.1, 4.0]; // harmless
    let reverted = topology::repair_moves(&mut moved, &before, &[None, None], None);
    assert_eq!(reverted, 1);
    assert_eq!(moved[0][1], [4.0, 0.0]);
    assert_eq!(moved[1][2], [9.1, 4.0], "the harmless move survives");
}

/// Review of #6883: a cell budget below what the padding needs fell into a
/// 4×4 fallback grid with too little padding, and the trace then underflowed
/// a row index (a wasm trap). Every budget is either refused up front or
/// traced validly, for a few points and for a spread-out slab.
#[test]
fn every_accepted_cell_budget_traces_without_panicking() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2));
    let slab = scene.sample(&SampleSpec { per_metre: 40.0, ..Default::default() });
    let few = [0.0f32, 0.0, 0.01, 0.0, 0.0, 0.01, 50.0, 50.0];
    let mut accepted = 0;
    for max_cells in 1..=200usize {
        let opts = ScanOutlineOptions { max_cells, ..Default::default() };
        if opts.validate().is_err() {
            continue;
        }
        accepted += 1;
        for pts in [&few[..], &slab[..]] {
            let o = trace_scan_outline(pts, &opts).expect("accepted options trace");
            assert_valid(&o);
            let d = &o.diagnostics;
            assert!(d.grid_width * d.grid_height <= max_cells, "budget {max_cells} exceeded");
        }
    }
    assert!(accepted > 0, "some budget under 200 cells must be accepted");
    // The documented floor follows the padding: refused right below it.
    let floor = ScanOutlineOptions::default().min_cells();
    assert!(ScanOutlineOptions { max_cells: floor, ..Default::default() }.validate().is_ok());
    assert!(ScanOutlineOptions { max_cells: floor - 1, ..Default::default() }.validate().is_err());
}

/// Review of #6883: options that size work or memory by a cell count are
/// bounded, so a typo cannot allocate gigabytes or run for seconds.
#[test]
fn work_sizing_options_are_bounded() {
    for opts in [
        ScanOutlineOptions { max_vertex_move_cells: 1e4, ..Default::default() },
        ScanOutlineOptions { snap_distance_cells: 600.0, ..Default::default() },
        ScanOutlineOptions { min_cell_size: 1e-6, max_cell_size: 1e-6, ..Default::default() },
    ] {
        assert!(trace_scan_outline(&[0.0, 0.0], &opts).is_err(), "{opts:?}");
    }
}

/// Review of #6883: a small column at 20° inside a 0° room is 20° off the
/// dominant direction, far beyond the 3° (or 12° with a short offset)
/// tolerance, so it must keep its own direction. Squaring every edge, or a
/// tolerance ten times too wide, turns it to 0°.
#[test]
fn a_column_well_off_the_building_direction_is_not_squared() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2));
    let mut pts = scene.sample(&SampleSpec::default());
    let mut rng = Rng::new(20);
    let (s, c) = 20f64.to_radians().sin_cos();
    let (hw, hd) = (0.225, 0.15);
    let perimeter = 2.0 * (2.0 * hw + 2.0 * hd);
    for _ in 0..(perimeter * 300.0) as usize {
        let u = rng.unit() * perimeter;
        let (w, d) = (2.0 * hw, 2.0 * hd);
        let local = if u < w {
            [-hw + u, -hd]
        } else if u < w + d {
            [hw, -hd + (u - w)]
        } else if u < 2.0 * w + d {
            [hw - (u - w - d), hd]
        } else {
            [-hw, hd - (u - 2.0 * w - d)]
        };
        let (x, y) = (3.0 + c * local[0] - s * local[1] + 0.003 * rng.gauss(), 2.0 + s * local[0] + c * local[1] + 0.003 * rng.gauss());
        pts.extend_from_slice(&[x as f32, y as f32]);
    }
    // A generous move budget, so the move cap and the support check cannot
    // hide a wrong squaring decision: only the tolerance may keep it at 20°.
    let opts = ScanOutlineOptions { max_vertex_move_cells: 32.0, ..Default::default() };
    let o = trace_scan_outline(&pts, &opts).unwrap();
    assert_valid(&o);
    let column = o.shape_offsets.iter().copied().find(|&r| polygon_area(&o.rings[r]) < 1.0).expect("the column is its own shape");
    let ring = &o.rings[column];
    let n = ring.len();
    let long: Vec<f64> = (0..n)
        .filter(|&k| (ring[(k + 1) % n][0] - ring[k][0]).hypot(ring[(k + 1) % n][1] - ring[k][1]) > 0.2)
        .map(|k| {
            let (a, b) = (ring[k], ring[(k + 1) % n]);
            let ang = (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees();
            (ang - 20.0 + 45.0).rem_euclid(90.0) - 45.0
        })
        .collect();
    assert!(!long.is_empty());
    for dev in long {
        assert!(dev.abs() < 2.0, "column edge turned {dev}° away from its 20°");
    }
}

/// Review of #6883: `squaredEdges` counts only squarings that survive, and
/// every move undone (by the move cap or the repair loop) is in `revertedMoves`.
#[test]
fn squared_edges_count_only_surviving_squarings() {
    let scene = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2)).placed(1.0, [0.0, 0.0]);
    let pts = scene.sample(&SampleSpec::default());
    // A move cap of zero undoes every squaring move.
    let opts = ScanOutlineOptions { max_vertex_move_cells: 0.0, snap: false, ..Default::default() };
    let o = trace_scan_outline(&pts, &opts).unwrap();
    assert_valid(&o);
    assert_eq!(o.diagnostics.squared_edges, 0, "{:?}", o.diagnostics);
    assert!(o.diagnostics.reverted_moves > 0, "the undone moves are reported");
}

/// Review of #6883: f32 input far from the origin cannot resolve the cells;
/// the run says so instead of silently returning a staircase or nothing.
#[test]
fn far_from_origin_input_reports_degraded_precision() {
    let near = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2));
    let far = Scene::new(room_walls(0.0, 0.0, 6.0, 4.0, 0.2)).placed(0.0, [2_600_000.0, 1_200_000.0]);
    let opts = ScanOutlineOptions::default();
    let n = trace_scan_outline(&near.sample(&SampleSpec::default()), &opts).unwrap();
    let f = trace_scan_outline(&far.sample(&SampleSpec::default()), &opts).unwrap();
    assert!(!n.diagnostics.coordinate_precision_degraded);
    assert!(n.diagnostics.coordinate_spacing_metres < 1e-5);
    assert!(f.diagnostics.coordinate_precision_degraded, "{:?}", f.diagnostics);
    assert!(f.diagnostics.coordinate_spacing_metres >= 0.25);
}
