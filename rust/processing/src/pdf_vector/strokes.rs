// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Solid straight strokes become construction-space offset contours,
//! then undergo the complete affine transform. No scalar-width
//! approximation is made for nonuniformly scaled or sheared PDF paths.
use super::{
    fill_paths::{point, PathRings},
    flatten::charge,
    PdfVectorGraphicsState,
};
use ifc_lite_geometry::{kernel::Sign, Ring2D};
type Point = [f64; 2];
fn add(a: Point, b: Point) -> Point {
    [a[0] + b[0], a[1] + b[1]]
}
fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}
fn mul(a: Point, s: f64) -> Point {
    [a[0] * s, a[1] * s]
}
fn cross(a: Point, b: Point) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn dot(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn arc(
    centre: Point,
    start: Point,
    sweep: f64,
    state: &PdfVectorGraphicsState,
    tolerance: f64,
    remaining: &mut u64,
) -> Result<Vec<Point>, String> {
    let radius = sub(start, centre);
    let h = radius[0].hypot(radius[1]);
    let [a, b, c, d, _, _] = state.model_metres_from_path;
    // The largest singular value bounds the affine map, so
    // an inscribed construction-space arc is within `tolerance` after every
    // supported nonuniform scale, reflection and shear.
    let trace = a * a + b * b + c * c + d * d;
    let determinant = a * d - b * c;
    let discriminant = (trace * trace - 4. * determinant * determinant).max(0.);
    let max_scale = ((trace + discriminant.sqrt()) / 2.).sqrt() * (1. + 16. * f64::EPSILON);
    let model_radius_bound = h * max_scale;
    if !model_radius_bound.is_finite() || model_radius_bound == 0. {
        return Err("PDF round stroke cap/join collapses in the model plane".into());
    }
    // Chord sagitta alone is not a metric certificate when forming and
    // transforming an arc point can already lose more than the allowance.
    // Bound the affine operands rather than only the final point: translation
    // or cancellation can otherwise hide the magnitude that drives roundoff.
    let [tx, ty] = [state.model_metres_from_path[4], state.model_metres_from_path[5]];
    let magnitude = (a.abs() * centre[0].abs() + c.abs() * centre[1].abs() + tx.abs())
        .max(b.abs() * centre[0].abs() + d.abs() * centre[1].abs() + ty.abs())
        .max(model_radius_bound)
        .max(1.);
    let roundoff = 256. * f64::EPSILON * magnitude;
    if !roundoff.is_finite() || roundoff >= tolerance {
        return Err("PDF round stroke tolerance is below model-coordinate numerical precision".into());
    }
    let ratio = ((tolerance - roundoff) / model_radius_bound).min(1.);
    // sagitta / radius = 1-cos(step/2) = 2*sin(step/4)^2.
    // The asin form stays meaningful when `ratio` is below machine epsilon;
    // subtracting it from one would round up and under-subdivide shallow arcs.
    let max_step = 4. * (ratio / 2.).sqrt().asin();
    let segments = (sweep.abs() / max_step).ceil().max(1.) as usize;
    if segments > 1024 {
        return Err("PDF round stroke cap/join exceeds flattened vertex budget".into());
    }
    charge(remaining, (segments * 8) as u64)?;
    let start_angle = radius[1].atan2(radius[0]);
    Ok((0..=segments)
        .map(|i| {
            let angle = start_angle + sweep * i as f64 / segments as f64;
            add(centre, [h * angle.cos(), h * angle.sin()])
        })
        .collect())
}

#[cfg(test)]
#[path = "strokes_tests.rs"]
mod tests;
fn direction(a: Point, b: Point) -> Result<Point, String> {
    let d = sub(b, a);
    let length = d[0].hypot(d[1]);
    if !length.is_finite() || length == 0. {
        return Err("PDF stroke has a zero-length segment".into());
    }
    Ok(mul(d, 1. / length))
}
fn emit(
    out: &mut PathRings,
    p: &[Point],
    state: &PdfVectorGraphicsState,
    remaining: &mut u64,
) -> Result<(), String> {
    charge(remaining, p.len() as u64)?;
    if out.rings.len() >= 1024 {
        return Err("PDF stroke exceeds outline piece budget".into());
    }
    let mut ring: Ring2D = p
        .iter()
        .map(|p| point(state.model_metres_from_path, *p))
        .collect::<Result<_, _>>()?;
    let a = ring[0];
    let area = (1..ring.len() - 1)
        .map(|i| cross(sub(ring[i], a), sub(ring[i + 1], a)))
        .sum::<f64>();
    if !area.is_finite() || area == 0. {
        return Err("PDF stroke outline collapses at model precision".into());
    }
    if area < 0. {
        ring.reverse();
    }
    out.rings.push(ring);
    out.curved.push(false);
    Ok(())
}
fn join(
    [p, previous, next]: [Point; 3],
    side: f64,
    h: f64,
    state: &PdfVectorGraphicsState,
    tolerance: f64,
    remaining: &mut u64,
) -> Result<Vec<Point>, String> {
    let turn = cross(previous, next);
    let cosine = dot(previous, next);
    let a = add(p, mul([-previous[1], previous[0]], side * h));
    let b = add(p, mul([-next[1], next[0]], side * h));
    if turn == 0. {
        if cosine <= 0. {
            return Err("PDF stroke reverses direction at a join".into());
        }
        return Ok(vec![a]);
    }
    let t = cross(sub(b, a), next) / turn;
    let tip = add(a, mul(previous, t));
    let residual = sub(tip, p);
    let ratio = residual[0].hypot(residual[1]) / h;
    if !ratio.is_finite() {
        return Err("PDF stroke join exceeds numeric range".into());
    }
    // Inner boundaries meet at the offset-line intersection. On the outer
    // side, the miter limit replaces the tip with a bevel when exceeded.
    if side * turn > 0. || (state.line_join == 0 && ratio <= state.miter_limit) {
        Ok(vec![tip])
    } else if state.line_join == 1 {
        let start_angle = sub(a, p)[1].atan2(sub(a, p)[0]);
        let end_angle = sub(b, p)[1].atan2(sub(b, p)[0]);
        let mut sweep = end_angle - start_angle;
        if turn > 0. && sweep < 0. {
            sweep += std::f64::consts::TAU;
        } else if turn < 0. && sweep > 0. {
            sweep -= std::f64::consts::TAU;
        }
        arc(p, a, sweep, state, tolerance, remaining)
    } else {
        Ok(vec![a, b])
    }
}
fn signed_area(p: &[Point]) -> f64 {
    (1..p.len() - 1)
        .map(|i| cross(sub(p[i], p[0]), sub(p[i + 1], p[0])))
        .sum()
}
fn outline(
    points: &[Point],
    closed: bool,
    state: &PdfVectorGraphicsState,
    out: &mut PathRings,
    remaining: &mut u64,
    tolerance: f64,
) -> Result<(), String> {
    let points = if closed && points.len() > 1 && points.first() == points.last() {
        &points[..points.len() - 1]
    } else {
        points
    };
    if points.len() < 2 || (closed && points.len() < 3) {
        return Err("PDF stroke has a degenerate subpath".into());
    }
    let h = state.line_width / 2.;
    let count = points.len() - usize::from(!closed);
    let directions: Vec<_> = (0..count)
        .map(|i| direction(points[i], points[(i + 1) % points.len()]))
        .collect::<Result<_, _>>()?;
    charge(remaining, (count * 32) as u64)?;
    for i in usize::from(!closed)..count {
        let exact = super::curve_hulls::sign(
            points[(i + points.len() - 1) % points.len()],
            points[i],
            points[(i + 1) % points.len()],
        );
        let turn = cross(directions[(i + count - 1) % count], directions[i]);
        let computed = if turn > 0. {
            Sign::Positive
        } else if turn < 0. {
            Sign::Negative
        } else {
            Sign::Zero
        };
        if computed != exact || (turn != 0. && turn.abs() < 1e-8) {
            return Err("PDF stroke join is numerically unresolved".into());
        }
    }
    let mut sides = Vec::with_capacity(2);
    for side in [1., -1.] {
        let mut edge = vec![];
        for (i, &p) in points.iter().enumerate() {
            if closed || (i > 0 && i < count) {
                edge.extend(join(
                    [p, directions[(i + count - 1) % count], directions[i % count]],
                    side,
                    h,
                    state,
                    tolerance,
                    remaining,
                )?);
            } else {
                let d = directions[if i == 0 { 0 } else { count - 1 }];
                let cap = if state.line_cap == 2 {
                    mul(d, if i == 0 { -h } else { h })
                } else {
                    [0.; 2]
                };
                edge.push(add(add(p, cap), mul([-d[1], d[0]], side * h)));
            }
        }
        // A wide inward offset may pass through a vertex and become a
        // positively wound but fictitious inner polygon. Every offset segment
        // must still advance along its original segment before classification.
        for i in 0..count {
            let p = points[i];
            let q = points[(i + 1) % points.len()];
            let d = directions[i];
            let start = if closed || i > 0 {
                *join([p, directions[(i + count - 1) % count], d], side, h, state, tolerance, remaining)?
                    .last()
                    .unwrap()
            } else {
                edge[0]
            };
            let end = if closed || i + 1 < count {
                join([q, d, directions[(i + 1) % count]], side, h, state, tolerance, remaining)?[0]
            } else {
                *edge.last().unwrap()
            };
            if dot(sub(end, start), d) <= 0. {
                return Err("PDF stroke width collapses an offset segment".into());
            }
        }
        sides.push(edge);
    }
    if closed {
        super::stroke_topology::qualify(&sides, remaining)?;
        let source_area = signed_area(points);
        if source_area == 0. {
            return Err("PDF closed stroke has unresolved orientation".into());
        }
        let inner = usize::from(source_area < 0.);
        for (i, edge) in sides.iter().enumerate() {
            if signed_area(edge) * source_area <= 0. {
                return Err("PDF stroke offset collapses or reverses its boundary".into());
            }
            emit(out, edge, state, remaining)?;
            // emit normalizes metric winding; the inner boundary is a hole.
            if i == inner {
                out.rings.last_mut().unwrap().reverse();
            }
        }
    } else {
        let mut edge = sides.remove(0);
        let other = sides.remove(0);
        if state.line_cap == 1 {
            let end = *points.last().unwrap();
            let cap = arc(end, *edge.last().unwrap(), -std::f64::consts::PI, state, tolerance, remaining)?;
            let interior = cap.len().saturating_sub(2);
            edge.extend(cap.into_iter().skip(1).take(interior));
        }
        edge.extend(other.iter().rev().copied());
        if state.line_cap == 1 {
            let start = points[0];
            let cap = arc(start, other[0], -std::f64::consts::PI, state, tolerance, remaining)?;
            let interior = cap.len().saturating_sub(2);
            edge.extend(cap.into_iter().skip(1).take(interior));
        }
        super::stroke_topology::qualify(std::slice::from_ref(&edge), remaining)?;
        emit(out, &edge, state, remaining)?;
    }
    Ok(())
}
pub(super) fn rings(
    commands: &[f64],
    close_last: bool,
    state: &PdfVectorGraphicsState,
    remaining: &mut u64,
    tolerance: f64,
) -> Result<PathRings, String> {
    if state.line_width <= 0.
        || !state.dash_lengths.is_empty()
    {
        // The interpreter reports hairline and dashed strokes before
        // composition; reaching this is a planner invariant violation.
        return Err("Planner invariant: the interpreter must omit strokes without positive width or a solid line".into());
    }
    let mut out = PathRings {
        rings: vec![],
        curved: vec![],
    };
    let mut points = vec![];
    let mut cursor = 0;
    let mut just_closed = false;
    while cursor < commands.len() {
        let op = commands[cursor];
        cursor += 1;
        match op as u8 {
            0 => {
                if points.len() > 1 || (!points.is_empty() && !just_closed) {
                    outline(&points, false, state, &mut out, remaining, tolerance)?;
                }
                points = vec![[commands[cursor], commands[cursor + 1]]];
                cursor += 2;
                just_closed = false;
            }
            1 => {
                points.push([commands[cursor], commands[cursor + 1]]);
                cursor += 2;
                just_closed = false;
            }
            4 => {
                if !just_closed {
                    outline(&points, true, state, &mut out, remaining, tolerance)?;
                }
                points.truncate(1);
                just_closed = true;
            }
            _ => {
                return Err("Planner invariant: the interpreter must omit curved strokes".into())
            }
        }
    }
    if points.len() > 1 || (!points.is_empty() && !just_closed) {
        outline(&points, close_last, state, &mut out, remaining, tolerance)?;
    }
    Ok(out)
}
