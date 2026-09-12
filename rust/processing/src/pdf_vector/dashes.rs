// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Conservative PDF dash qualification and construction-space expansion.
//!
//! Dash distances live beside line width in the path's construction space.
//! Runs are therefore split before the complete paint-time affine is applied.
use super::flatten::charge;

type Point = [f64; 2];
const MAX_DASH_RUNS: usize = 1024;

/// Preparation may call a dashed stroke convertible only when the planner can
/// preserve its semantics. Closed and curved paths remain reportable omissions.
pub(super) fn supported(commands: &[f64], close_last: bool, pattern: &[f64]) -> bool {
    if close_last || pattern.is_empty() || pattern.iter().any(|length| *length <= 0.) {
        return false;
    }
    let mut cursor = 0;
    while cursor < commands.len() {
        match commands[cursor] {
            0. | 1. => cursor += 3,
            // Curves and explicit close-paths require separate qualifications.
            2. | 3. | 4. => return false,
            _ => return false,
        }
    }
    true
}

fn point_at(a: Point, b: Point, distance: f64, length: f64) -> Point {
    let t = distance / length;
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn finish(run: &mut Vec<Point>, runs: &mut Vec<Vec<Point>>) -> Result<(), String> {
    if run.len() > 1 {
        if runs.len() == MAX_DASH_RUNS {
            return Err("PDF dashed stroke exceeds 1024 visible run pieces".into());
        }
        runs.push(std::mem::take(run));
    }
    run.clear();
    Ok(())
}

/// Expand one open polyline. Pattern state resets at each PDF subpath and is
/// continuous across its vertices, so an on-run crossing a corner keeps the
/// ordinary PDF join instead of gaining two artificial caps.
fn subpath(
    points: &[Point], pattern: &[f64], phase: f64,
    runs: &mut Vec<Vec<Point>>, remaining: &mut u64,
) -> Result<(), String> {
    if points.len() < 2 {
        return Ok(());
    }
    let cycle: f64 = pattern.iter().sum();
    if !cycle.is_finite() || cycle <= 0. {
        return Err("PDF dash cycle exceeds numeric range".into());
    }
    let mut offset = phase.rem_euclid(cycle);
    let mut pattern_index = 0;
    while offset >= pattern[pattern_index] {
        offset -= pattern[pattern_index];
        pattern_index = (pattern_index + 1) % pattern.len();
    }
    let mut dash_left = pattern[pattern_index] - offset;
    let mut run = Vec::new();
    for segment in points.windows(2) {
        let [a, b] = [segment[0], segment[1]];
        let length = (b[0] - a[0]).hypot(b[1] - a[1]);
        if !length.is_finite() || length == 0. {
            return Err("PDF dashed stroke has a zero-length segment".into());
        }
        let mut travelled = 0.;
        while travelled < length {
            // Charge before each output decision. Tiny patterns over long
            // segments terminate on the shared page budget without allocating
            // an attacker-controlled number of runs.
            charge(remaining, 8)?;
            let step = dash_left.min(length - travelled);
            if step <= 0. || travelled + step == travelled {
                return Err("PDF dash cannot advance at numeric precision".into());
            }
            let start = point_at(a, b, travelled, length);
            travelled += step;
            let end = if travelled >= length { b } else { point_at(a, b, travelled, length) };
            if pattern_index % 2 == 0 {
                if run.last() != Some(&start) {
                    run.push(start);
                }
                if run.last() != Some(&end) {
                    run.push(end);
                }
            }
            dash_left -= step;
            let boundary = dash_left <= 0. || dash_left + step == step;
            if boundary {
                if pattern_index % 2 == 0 {
                    finish(&mut run, runs)?;
                }
                pattern_index = (pattern_index + 1) % pattern.len();
                dash_left = pattern[pattern_index];
            }
        }
    }
    finish(&mut run, runs)
}

/// Split all open straight subpaths into their visible on-runs. An odd pattern
/// is repeated once as required by PDF, and phase is normalized over that
/// effective even cycle.
pub(super) fn expand(
    commands: &[f64], pattern: &[f64], phase: f64, remaining: &mut u64,
) -> Result<Vec<Vec<Point>>, String> {
    if pattern.is_empty() || pattern.iter().any(|length| !length.is_finite() || *length <= 0.) {
        return Err("Planner invariant: unsupported PDF dash pattern reached expansion".into());
    }
    let mut effective = pattern.to_vec();
    if effective.len() % 2 == 1 {
        effective.extend_from_slice(pattern);
    }
    let mut runs = Vec::new();
    let mut points = Vec::new();
    let mut cursor = 0;
    while cursor < commands.len() {
        match commands[cursor] {
            0. => {
                subpath(&points, &effective, phase, &mut runs, remaining)?;
                points.clear();
                points.push([commands[cursor + 1], commands[cursor + 2]]);
                cursor += 3;
            }
            1. => {
                points.push([commands[cursor + 1], commands[cursor + 2]]);
                cursor += 3;
            }
            _ => return Err("Planner invariant: unsupported dashed PDF path reached expansion".into()),
        }
    }
    subpath(&points, &effective, phase, &mut runs, remaining)?;
    Ok(runs)
}

#[cfg(test)]
#[path = "dashes_tests.rs"]
mod tests;
