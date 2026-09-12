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
/// preserve its semantics. Straight open and closed subpaths are supported;
/// curves remain reportable omissions.
pub(super) fn supported(commands: &[f64], _close_last: bool, pattern: &[f64]) -> bool {
    if pattern.is_empty() || pattern.iter().any(|length| *length <= 0.) {
        return false;
    }
    let mut cursor = 0;
    while cursor < commands.len() {
        match commands[cursor] {
            0. | 1. => cursor += 3,
            2. | 3. => return false,
            4. => cursor += 1,
            _ => return false,
        }
    }
    true
}

/// A capped closed dash whose first on interval covers the whole perimeter has
/// coincident, independently capped ends. The general open-stroke contour is
/// self-touching there, so this remains an explicit topology omission until it
/// has a dedicated multi-ring decomposition.
pub(super) fn has_capped_loop(
    commands: &[f64],
    close_last: bool,
    pattern: &[f64],
    phase: f64,
) -> bool {
    let mut effective = pattern.to_vec();
    if effective.len() % 2 == 1 {
        effective.extend_from_slice(pattern);
    }
    let cycle: f64 = effective.iter().sum();
    let mut offset = phase.rem_euclid(cycle);
    let mut index = 0;
    while offset >= effective[index] {
        offset -= effective[index];
        index = (index + 1) % effective.len();
    }
    if index % 2 == 1 {
        return false;
    }
    let first_on_left = effective[index] - offset;
    let qualifies = |points: &[[f64; 2]], closed: bool| {
        if !closed || points.len() < 2 {
            return false;
        }
        let points = if points.first() == points.last() {
            &points[..points.len() - 1]
        } else {
            points
        };
        let perimeter = (0..points.len())
            .map(|i| {
                let [a, b] = [points[i], points[(i + 1) % points.len()]];
                (b[0] - a[0]).hypot(b[1] - a[1])
            })
            .sum::<f64>();
        let error = 32.
            * f64::EPSILON
            * perimeter.abs().max(first_on_left.abs())
            * points.len() as f64;
        perimeter.is_finite()
            && (perimeter <= first_on_left || (perimeter - first_on_left).abs() <= error)
    };
    let mut points = Vec::new();
    let mut cursor = 0;
    while cursor < commands.len() {
        match commands[cursor] {
            0. => {
                points.clear();
                points.push([commands[cursor + 1], commands[cursor + 2]]);
                cursor += 3;
            }
            1. => {
                points.push([commands[cursor + 1], commands[cursor + 2]]);
                cursor += 3;
            }
            4. => {
                if qualifies(&points, true) {
                    return true;
                }
                points.truncate(1);
                cursor += 1;
            }
            _ => return false,
        }
    }
    qualifies(&points, close_last)
}

#[derive(Debug, PartialEq)]
pub(super) struct DashRun {
    pub points: Vec<Point>,
    pub closed: bool,
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

/// Expand one polyline. Pattern state resets at each PDF subpath and is
/// continuous across its vertices. For a closed subpath the closing edge is
/// traversed too, and visible pieces meeting across the closure seam are joined.
fn subpath(
    points: &[Point], closed: bool, join_seam: bool, pattern: &[f64], phase: f64,
    remaining: &mut u64,
) -> Result<Vec<DashRun>, String> {
    let points = if closed && points.len() > 1 && points.first() == points.last() {
        &points[..points.len() - 1]
    } else {
        points
    };
    if points.len() < 2 {
        return Ok(vec![]);
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
    let starts_on = pattern_index % 2 == 0;
    let mut run = Vec::new();
    let segment_count = points.len() - usize::from(!closed);
    let mut raw_runs = Vec::new();
    let mut decisions = 0_u64;
    for i in 0..segment_count {
        let [a, b] = [points[i], points[(i + 1) % points.len()]];
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
            decisions = decisions.saturating_add(1);
            let segment_left = length - travelled;
            // `dash_left` and `segment_left` arrive through independent chains
            // of floating-point subtraction. At a mathematical dash boundary
            // on a vertex they can differ by a few ulps (for example a 0.2/0.1
            // pattern around a 0.075 square). Without snapping inside the
            // propagated error envelope, that residue becomes a microscopic
            // extra run and changes a seam cap into a join. The second check
            // refuses inputs whose progress itself is smaller than the error
            // envelope: snapping those would choose topology without evidence.
            let scale = length
                .abs()
                .max(cycle.abs())
                .max(dash_left.abs())
                .max(segment_left.abs());
            let progress_error = 32. * f64::EPSILON * scale * decisions as f64;
            let coincident_boundary = (dash_left - segment_left).abs() <= progress_error;
            if coincident_boundary
                && progress_error * 4. >= dash_left.abs().min(segment_left.abs())
            {
                return Err("PDF dash boundary is unresolved at numeric precision".into());
            }
            let step = if coincident_boundary {
                segment_left
            } else {
                dash_left.min(segment_left)
            };
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
            dash_left = if coincident_boundary { 0. } else { dash_left - step };
            let boundary = dash_left <= 0. || dash_left + step == step;
            if boundary {
                if pattern_index % 2 == 0 {
                    finish(&mut run, &mut raw_runs)?;
                }
                pattern_index = (pattern_index + 1) % pattern.len();
                dash_left = pattern[pattern_index];
            }
        }
    }
    finish(&mut run, &mut raw_runs)?;

    let ends_on = pattern_index % 2 == 0 && dash_left < pattern[pattern_index];
    if closed && join_seam && starts_on && ends_on && !raw_runs.is_empty() {
        if raw_runs.len() == 1 {
            return Ok(vec![DashRun { points: raw_runs.pop().unwrap(), closed: true }]);
        }
        let first = raw_runs.remove(0);
        let last = raw_runs.last_mut().unwrap();
        if last.last() == first.first() {
            last.extend(first.into_iter().skip(1));
        } else {
            last.extend(first);
        }
    }
    Ok(raw_runs.into_iter().map(|points| DashRun { points, closed: false }).collect())
}

/// Split all straight subpaths into their visible on-runs. An odd pattern
/// is repeated once as required by PDF, and phase is normalized over that
/// effective even cycle.
pub(super) fn expand(
    commands: &[f64], close_last: bool, join_seam: bool, pattern: &[f64], phase: f64,
    remaining: &mut u64,
) -> Result<Vec<DashRun>, String> {
    if pattern.is_empty() || pattern.iter().any(|length| !length.is_finite() || *length <= 0.) {
        return Err("Planner invariant: unsupported PDF dash pattern reached expansion".into());
    }
    let mut effective = pattern.to_vec();
    if effective.len() % 2 == 1 {
        effective.extend_from_slice(pattern);
    }
    let mut runs = Vec::new();
    let mut points = Vec::new();
    let mut just_closed = false;
    let mut cursor = 0;
    while cursor < commands.len() {
        match commands[cursor] {
            0. => {
                append_subpath(
                    &mut runs,
                    subpath(&points, false, false, &effective, phase, remaining)?,
                )?;
                points.clear();
                points.push([commands[cursor + 1], commands[cursor + 2]]);
                cursor += 3;
                just_closed = false;
            }
            1. => {
                points.push([commands[cursor + 1], commands[cursor + 2]]);
                cursor += 3;
                just_closed = false;
            }
            4. => {
                if !just_closed {
                    append_subpath(
                        &mut runs,
                        subpath(&points, true, join_seam, &effective, phase, remaining)?,
                    )?;
                }
                points.truncate(1);
                cursor += 1;
                just_closed = true;
            }
            _ => return Err("Planner invariant: unsupported dashed PDF path reached expansion".into()),
        }
    }
    if !just_closed {
        append_subpath(
            &mut runs,
            subpath(
                &points,
                close_last,
                join_seam,
                &effective,
                phase,
                remaining,
            )?,
        )?;
    }
    Ok(runs)
}

fn append_subpath(runs: &mut Vec<DashRun>, mut next: Vec<DashRun>) -> Result<(), String> {
    if runs.len() + next.len() > MAX_DASH_RUNS {
        return Err("PDF dashed stroke exceeds 1024 visible run pieces".into());
    }
    runs.append(&mut next);
    Ok(())
}

#[cfg(test)]
#[path = "dashes_tests.rs"]
mod tests;
