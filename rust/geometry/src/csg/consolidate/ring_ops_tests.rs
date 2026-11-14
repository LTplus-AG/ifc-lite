// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{simplify_2d_collinear, weld_near_coincident_2d_tracked, Welded};
use nalgebra::Point2;

fn square() -> Vec<Point2<f64>> {
    vec![
        Point2::new(0.0, 0.0),
        Point2::new(2.0, 0.0),
        Point2::new(2.0, 2.0),
        Point2::new(0.0, 2.0),
    ]
}

fn collinear_ring(n: usize) -> Vec<Point2<f64>> {
    (0..n).map(|i| Point2::new(i as f64, 0.0)).collect()
}

#[test]
fn issue_6537_canonical_ring_simplifier_preserves_corners_and_order() {
    let corners = square();
    assert_eq!(simplify_2d_collinear(&corners), corners);
    let mut with_phantom = corners.clone();
    with_phantom.insert(1, Point2::new(1.0, 0.0));
    assert_eq!(simplify_2d_collinear(&with_phantom), corners);
    // The existing sequential sweep retains the last two collinear vertices.
    // Counter instrumentation must not change this degenerate-ring result.
    let line = collinear_ring(6);
    assert_eq!(simplify_2d_collinear(&line), line[4..]);
    for n in 0..4 {
        assert_eq!(simplify_2d_collinear(&corners[..n]), corners[..n]);
    }
}

#[cfg(feature = "opening-perf-trace")]
mod work_counters {
    use super::*;
    use crate::opening_perf_trace::take;

    #[cfg(feature = "opening-perf-trace")]
    #[test]
    fn issue_6537_short_rings_record_calls_without_search_work() {
        let ring = square();
        for n in 0..4 {
            take();
            assert_eq!(simplify_2d_collinear(&ring[..n]), ring[..n]);
            let c = take();
            assert_eq!(c.ring_simplifier_calls, 1);
            assert_eq!(c.ring_simplifier_input_vertices, n as u64);
            assert_eq!(c.ring_simplifier_sweeps, 0);
            assert_eq!(c.ring_simplifier_live_vertex_visits, 0);
            assert_eq!(c.ring_simplifier_prev_probes, 0);
            assert_eq!(c.ring_simplifier_next_probes, 0);
            assert_eq!(c.ring_simplifier_removals, 0);
            assert_eq!(c.ring_simplifier_max_prev_probe_distance, 0);
            assert_eq!(c.ring_simplifier_max_next_probe_distance, 0);
        }
    }

    #[cfg(feature = "opening-perf-trace")]
    #[test]
    fn issue_6537_live_square_visits_probe_both_adjacent_neighbours() {
        take();
        let ring = square();
        assert_eq!(simplify_2d_collinear(&ring), ring);
        let c = take();
        assert_eq!(c.ring_simplifier_calls, 1);
        assert_eq!(c.ring_simplifier_input_vertices, 4);
        assert_eq!(c.ring_simplifier_sweeps, 1);
        assert_eq!(c.ring_simplifier_live_vertex_visits, 4);
        assert_eq!(c.ring_simplifier_prev_probes, 4);
        assert_eq!(c.ring_simplifier_next_probes, 4);
        assert_eq!(c.ring_simplifier_removals, 0);
        assert_eq!(c.ring_simplifier_max_prev_probe_distance, 1);
        assert_eq!(c.ring_simplifier_max_next_probe_distance, 1);
    }

    #[cfg(feature = "opening-perf-trace")]
    #[test]
    fn issue_6537_collinear_ring_counts_actual_quadratic_neighbour_probes() {
        for n in [4, 6, 32, 64] {
            take();
            let ring = collinear_ring(n);
            assert_eq!(simplify_2d_collinear(&ring), ring[n - 2..]);
            let c = take();
            let n = n as u64;
            assert_eq!(c.ring_simplifier_calls, 1);
            assert_eq!(c.ring_simplifier_input_vertices, n);
            assert_eq!(c.ring_simplifier_sweeps, 2);
            assert_eq!(c.ring_simplifier_live_vertex_visits, n + 2);
            assert_eq!(c.ring_simplifier_removals, n - 2);
            // First sweep: prev distances 1..n-1, then 1; next distances
            // 1 repeated n-1 times, then n-1. The two surviving vertices
            // each probe distances 1 and n-1 on the final unchanged sweep.
            assert_eq!(c.ring_simplifier_prev_probes, n * (n - 1) / 2 + n + 1);
            assert_eq!(c.ring_simplifier_next_probes, 3 * n - 2);
            assert_eq!(c.ring_simplifier_max_prev_probe_distance, n - 1);
            assert_eq!(c.ring_simplifier_max_next_probe_distance, n - 1);
            assert!(c.ring_simplifier_prev_probes >= c.ring_simplifier_live_vertex_visits);
            assert!(c.ring_simplifier_next_probes >= c.ring_simplifier_live_vertex_visits);
        }
    }

    #[cfg(feature = "opening-perf-trace")]
    #[test]
    fn issue_6537_clean_ring_counts_post_weld_vertices() {
        take();
        let ring = [[0.0, 0.0], [0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
        assert_eq!(
            super::super::clean_ring(&ring, 4.0, 1.0),
            Some(square()),
        );
        let c = take();
        assert_eq!(c.ring_simplifier_calls, 1);
        assert_eq!(c.ring_simplifier_input_vertices, 4);
        assert_eq!(c.ring_simplifier_live_vertex_visits, 4);
        assert_eq!(c.ring_simplifier_prev_probes + c.ring_simplifier_next_probes, 8);
        assert_eq!(c.ring_simplifier_removals, 0);
    }

    #[cfg(feature = "opening-perf-trace")]
    #[test]
    fn issue_6537_job_totals_add_work_but_take_maximum_search_distance() {
        take();
        let corners = square();
        let line = collinear_ring(6);
        assert_eq!(simplify_2d_collinear(&line), line[4..]);
        assert_eq!(simplify_2d_collinear(&corners), corners);
        assert_eq!(simplify_2d_collinear(&corners[..3]), corners[..3]);
        let c = take();
        assert_eq!(c.ring_simplifier_calls, 3);
        assert_eq!(c.ring_simplifier_input_vertices, 13);
        assert_eq!(c.ring_simplifier_sweeps, 3);
        assert_eq!(c.ring_simplifier_live_vertex_visits, 12);
        assert_eq!(c.ring_simplifier_prev_probes, 26);
        assert_eq!(c.ring_simplifier_next_probes, 20);
        assert_eq!(c.ring_simplifier_removals, 4);
        assert_eq!(c.ring_simplifier_max_prev_probe_distance, 5);
        assert_eq!(c.ring_simplifier_max_next_probe_distance, 5);
    }
}

/// #8190: the weld reports what it merged from beyond the conform's reach,
/// and only that. `a` is 150 um after the first corner and is recorded;
/// `b`, 50 um after the third, is within `CONFORM_TOL` and is not; the last
/// vertex, 200 um before the first, is recorded as coming before it.
#[test]
fn tracked_weld_reports_only_merges_from_beyond_the_conform_tolerance() {
    let p = nalgebra::Point2::new;
    // A 4 m ring, so the weld runs at its 244 um cap.
    let corners = [p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)];
    let (a, b, last) = (p(1.5e-4, 0.0), p(4.0, 4.0 + 5.0e-5), p(0.0, 2.0e-4));
    let ring = [corners[0], a, corners[1], corners[2], b, corners[3], last];
    let (kept, welded) = weld_near_coincident_2d_tracked(&ring);
    assert_eq!(kept, corners);
    assert_eq!(
        welded,
        [
            Welded { kept: corners[0], dropped: a, before: false },
            Welded { kept: corners[0], dropped: last, before: true },
        ]
    );
}
