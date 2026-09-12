// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn expand_all(commands: &[f64], pattern: &[f64], phase: f64) -> Vec<Vec<Point>> {
    expand(commands, pattern, phase, &mut 4_000_000).unwrap()
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
fn issue_4406_closed_curved_and_zero_patterns_are_not_qualified() {
    assert!(!supported(&[0., 0., 0., 1., 4., 0.], true, &[2., 1.]));
    assert!(!supported(&[0., 0., 0., 2., 1., 0., 2., 1., 3., 0.], false, &[2., 1.]));
    assert!(!supported(&[0., 0., 0., 1., 4., 0., 4.], false, &[2., 1.]));
    assert!(!supported(&[0., 0., 0., 1., 4., 0.], false, &[2., 0.]));
    assert!(supported(&[0., 0., 0., 1., 4., 0.], false, &[2., 1.]));
}

#[test]
fn issue_4406_dash_expansion_is_bounded_before_unbounded_output() {
    let error = expand(
        &[0., 0., 0., 1., 1_000_000., 0.],
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
    let error = expand(&commands, &[1_000., 1.], 0., &mut 64).unwrap_err();
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
