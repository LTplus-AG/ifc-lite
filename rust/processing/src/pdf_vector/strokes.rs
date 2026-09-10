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
use ifc_lite_geometry::Ring2D;
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
    p: Point,
    previous: Point,
    next: Point,
    side: f64,
    h: f64,
    state: &PdfVectorGraphicsState,
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
    let mut sides = Vec::with_capacity(2);
    for side in [1., -1.] {
        let mut edge = vec![];
        for (i, &p) in points.iter().enumerate() {
            if closed || (i > 0 && i < count) {
                edge.extend(join(
                    p,
                    directions[(i + count - 1) % count],
                    directions[i % count],
                    side,
                    h,
                    state,
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
                *join(p, directions[(i + count - 1) % count], d, side, h, state)?
                    .last()
                    .unwrap()
            } else {
                edge[0]
            };
            let end = if closed || i + 1 < count {
                join(q, d, directions[(i + 1) % count], side, h, state)?[0]
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
        edge.extend(sides.remove(0).into_iter().rev());
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
) -> Result<PathRings, String> {
    if state.line_width <= 0.
        || state.line_cap == 1
        || state.line_join == 1
        || !state.dash_lengths.is_empty()
    {
        return Err("PDF stroke requires positive width, butt/square caps, bevel/miter joins and no dash pattern".into());
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
                    outline(&points, false, state, &mut out, remaining)?;
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
                    outline(&points, true, state, &mut out, remaining)?;
                }
                points.truncate(1);
                just_closed = true;
            }
            _ => {
                return Err(
                    "PDF curved strokes are not qualified; no partial page is created".into(),
                )
            }
        }
    }
    if points.len() > 1 || (!points.is_empty() && !just_closed) {
        outline(&points, close_last, state, &mut out, remaining)?;
    }
    Ok(out)
}
