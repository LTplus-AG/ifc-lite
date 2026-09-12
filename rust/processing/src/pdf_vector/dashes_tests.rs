// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn expand_all(commands: &[f64], pattern: &[f64], phase: f64) -> Vec<Vec<Point>> {
    expand(commands, false, pattern, phase, &mut 4_000_000)
        .unwrap()
        .into_iter()
        .map(|run| run.points)
        .collect()
}

#[test]
fn issue_4406_even_pattern_and_phase_continue_across_vertices() {
    let runs = expand_all(
        &[0., 0., 0., 1., 5., 0., 1., 5., 5.],
        &[4., 2.],
        1.,
    );
    assert_eq!(runs, [
        vec![[0., 0.], [3., 0.]],
        vec![[5., 0.], [5., 4.]],
    ]);
}

#[test]
fn issue_4406_on_run_crossing_a_vertex_keeps_one_joined_polyline() {
    let runs = expand_all(
        &[0., 0., 0., 1., 3., 0., 1., 3., 3.],
        &[5., 2.],
        0.,
    );
    assert_eq!(runs, [vec![[0., 0.], [3., 0.], [3., 2.]]]);
}

#[test]
fn issue_4406_odd_pattern_repeats_and_each_subpath_resets_phase() {
    let runs = expand_all(
        &[0., 0., 0., 1., 12., 0., 0., 0., 2., 1., 12., 2.],
        &[2., 1., 3.],
        7.,
    );
    let first: Vec<_> = runs.iter().filter(|run| run[0][1] == 0.).cloned().collect();
    let second: Vec<_> = runs.iter().filter(|run| run[0][1] == 2.).cloned().collect();
    assert_eq!(first, second.iter().map(|run| run.iter().map(|p| [p[0], p[1] - 2.]).collect::<Vec<_>>()).collect::<Vec<_>>());
    assert_eq!(first[0], vec![[1., 0.], [2., 0.]]);
}

#[test]
fn issue_4406_negative_phase_normalizes_over_the_effective_even_cycle() {
    let commands = [0., 0., 0., 1., 12., 0.];
    assert_eq!(
        expand_all(&commands, &[2., 1., 3.], -5.),
        expand_all(&commands, &[2., 1., 3.], 7.),
    );
}

#[test]
fn issue_4406_pdf_phase_examples_have_literal_on_run_endpoints() {
    let line = [0., 0., 0., 1., 12., 0.];
    assert_eq!(expand_all(&line, &[2.], 1.), [
        vec![[0., 0.], [1., 0.]], vec![[3., 0.], [5., 0.]],
        vec![[7., 0.], [9., 0.]], vec![[11., 0.], [12., 0.]],
    ]);
    assert_eq!(expand_all(&line, &[3., 5.], 6.), [
        vec![[2., 0.], [5., 0.]], vec![[10., 0.], [12., 0.]],
    ]);
    assert_eq!(expand_all(&line, &[2., 3.], 11.), [
        vec![[0., 0.], [1., 0.]], vec![[4., 0.], [6., 0.]],
        vec![[9., 0.], [11., 0.]],
    ]);
}

#[test]
fn issue_4406_exact_vertex_boundary_ends_a_run_but_crossing_keeps_the_join() {
    let commands = [0., 0., 0., 1., 3., 0., 1., 3., 4.];
    assert_eq!(expand_all(&commands, &[3., 2.], 0.), [
        vec![[0., 0.], [3., 0.]], vec![[3., 2.], [3., 4.]],
    ]);
    assert_eq!(expand_all(&commands, &[5., 2.], 0.), [
        vec![[0., 0.], [3., 0.], [3., 2.]],
    ]);
}

#[test]
fn issue_4583_closed_straight_paths_qualify_but_curves_and_zero_patterns_do_not() {
    assert!(supported(&[0., 0., 0., 1., 4., 0.], true, &[2., 1.]));
    assert!(!supported(&[0., 0., 0., 2., 1., 0., 2., 1., 3., 0.], false, &[2., 1.]));
    assert!(supported(&[0., 0., 0., 1., 4., 0., 4.], false, &[2., 1.]));
    assert!(!supported(&[0., 0., 0., 1., 4., 0.], false, &[2., 0.]));
    assert!(supported(&[0., 0., 0., 1., 4., 0.], false, &[2., 1.]));
}

fn square(close: bool) -> Vec<f64> {
    let mut commands = vec![0., 0., 0., 1., 4., 0., 1., 4., 4., 1., 0., 4.];
    if close {
        commands.push(4.);
    }
    commands
}

#[test]
fn issue_4583_on_run_crossing_closure_seam_is_one_joined_open_run() {
    let runs = expand(&square(true), false, &[4., 4.], 1., &mut 4_000_000).unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0], DashRun {
        points: vec![[4., 3.], [4., 4.], [1., 4.]],
        closed: false,
    });
    assert_eq!(runs[1], DashRun {
        points: vec![[0., 1.], [0., 0.], [3., 0.]],
        closed: false,
    });
}

#[test]
fn issue_4583_gap_at_closure_seam_keeps_visible_runs_separate() {
    let runs = expand(&square(true), false, &[4., 4.], 5., &mut 4_000_000).unwrap();
    assert_eq!(runs, [
        DashRun { points: vec![[3., 0.], [4., 0.], [4., 3.]], closed: false },
        DashRun { points: vec![[1., 4.], [0., 4.], [0., 1.]], closed: false },
    ]);
}

#[test]
fn issue_4583_dash_boundary_exactly_at_seam_does_not_merge_caps() {
    let runs = expand(&square(true), false, &[6., 4.], 0., &mut 4_000_000).unwrap();
    assert_eq!(runs, [
        DashRun {
            points: vec![[0., 0.], [4., 0.], [4., 2.]],
            closed: false,
        },
        DashRun {
            points: vec![[2., 4.], [0., 4.], [0., 0.]],
            closed: false,
        },
    ]);
}

#[test]
fn issue_4583_decimal_cycle_boundary_at_seam_does_not_create_a_phantom_join() {
    let side = 0.07500000000000001;
    let commands = vec![
        0., 0., 0., 1., side, 0., 1., side, side, 1., 0., side, 4.,
    ];
    let runs = expand(&commands, false, &[0.2, 0.1], 0., &mut 4_000_000).unwrap();
    assert_eq!(
        runs.len(),
        1,
        "a rounding residue must not become a second visible run: {runs:?}"
    );
    assert!(!runs[0].closed, "the gap immediately before the seam keeps the run capped");
    assert_eq!(runs[0].points.first(), Some(&[0., 0.]));
    assert_ne!(runs[0].points.last(), Some(&[0., 0.]));
}

#[test]
fn issue_4583_fully_visible_closed_dash_uses_a_closed_outline() {
    let runs = expand(&square(false), true, &[100., 1.], 0., &mut 4_000_000).unwrap();
    assert_eq!(runs, [DashRun {
        points: vec![[0., 0.], [4., 0.], [4., 4.], [0., 4.], [0., 0.]],
        closed: true,
    }]);
}

#[test]
fn issue_4583_explicit_close_and_close_paint_have_identical_dash_geometry() {
    assert_eq!(
        expand(&square(true), false, &[3., 2.], -1., &mut 4_000_000).unwrap(),
        expand(&square(false), true, &[3., 2.], -1., &mut 4_000_000).unwrap(),
    );
}

#[test]
fn issue_4583_redundant_line_to_start_before_close_adds_no_zero_length_edge() {
    let mut redundant = square(false);
    redundant.extend([1., 0., 0., 4.]);
    assert_eq!(
        expand(&redundant, false, &[3., 2.], -1., &mut 4_000_000).unwrap(),
        expand(&square(true), false, &[3., 2.], -1., &mut 4_000_000).unwrap(),
    );
}

#[test]
fn issue_4583_mixed_open_and_closed_subpaths_reset_phase_independently() {
    let mut commands = square(true);
    commands.extend([0., 10., 0., 1., 14., 0.]);
    let runs = expand(&commands, false, &[4., 4.], 1., &mut 4_000_000).unwrap();
    assert_eq!(runs.last().unwrap(), &DashRun {
        points: vec![[10., 0.], [13., 0.]],
        closed: false,
    });
}

#[test]
fn issue_4583_visible_piece_limit_is_global_across_subpaths() {
    let commands = [
        0., 0., 0., 1., 1_200., 0.,
        0., 0., 2., 1., 1_200., 2.,
    ];
    let error = expand(&commands, false, &[1., 1.], 0., &mut 4_000_000).unwrap_err();
    assert!(error.contains("1024 visible run pieces"), "{error}");
}

#[test]
fn issue_4406_dash_expansion_is_bounded_before_unbounded_output() {
    let error = expand(
        &[0., 0., 0., 1., 1_000_000., 0.],
        false,
        &[0.000001, 0.000001],
        0.,
        &mut 128,
    )
    .unwrap_err();
    assert!(error.contains("shared work budget"), "{error}");
}


#[test]
fn issue_4406_one_run_across_many_vertices_charges_each_growth_step() {
    let mut commands = vec![0., 0., 0.];
    for x in 1..=100 {
        commands.extend([1., f64::from(x), 0.]);
    }
    let error = expand(&commands, false, &[1_000., 1.], 0., &mut 64).unwrap_err();
    assert!(error.contains("shared work budget"), "{error}");
}

#[test]
fn issue_4406_geometrically_returning_open_run_is_not_silently_dropped() {
    let runs = expand_all(
        &[0., 0., 0., 1., 2., 0., 1., 0., 0.],
        &[10., 1.],
        0.,
    );
    assert_eq!(runs, [vec![[0., 0.], [2., 0.], [0., 0.]]]);
}

#[test]
fn issue_4406_short_path_fully_inside_a_gap_has_no_visible_runs() {
    assert!(expand_all(
        &[0., 0., 0., 1., 1., 0.],
        &[1., 100.],
        2.,
    )
    .is_empty());
}
