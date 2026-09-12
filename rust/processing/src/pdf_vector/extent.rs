// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Page-space extents for the fidelity report. Boxes are conservative
//! (control points, em-box estimates); they locate omissions, never certify them.
pub(super) type Rect = [f64; 4];
type Point = [f64; 2];

pub(super) fn apply(m: &[f64; 6], p: Point) -> Point {
    [
        m[0] * p[0] + m[2] * p[1] + m[4],
        m[1] * p[0] + m[3] * p[1] + m[5],
    ]
}
fn arity(op: u8) -> usize {
    match op {
        0 | 1 => 2,
        2 => 6,
        3 => 4,
        _ => 0,
    }
}
/// Every coordinate a DrawOPS command list touches, control points included.
/// Callers validate the command layout first.
pub(super) fn path_points(commands: &[f64]) -> impl Iterator<Item = Point> + '_ {
    let mut cursor = 0;
    std::iter::from_fn(move || {
        while cursor < commands.len() {
            let count = arity(commands[cursor] as u8);
            let start = cursor + 1;
            cursor = start + count;
            if count > 0 {
                return Some(
                    commands[start..cursor]
                        .chunks_exact(2)
                        .map(|c| [c[0], c[1]])
                        .collect::<Vec<_>>(),
                );
            }
        }
        None
    })
    .flatten()
}
/// Opcodes only, for feature checks such as curved strokes.
pub(super) fn opcodes(commands: &[f64]) -> impl Iterator<Item = u8> + '_ {
    let mut cursor = 0;
    std::iter::from_fn(move || {
        if cursor >= commands.len() {
            return None;
        }
        let op = commands[cursor] as u8;
        cursor += 1 + arity(op);
        Some(op)
    })
}
pub(super) fn bbox<I: IntoIterator<Item = Point>>(points: I) -> Option<Rect> {
    let mut out: Option<Rect> = None;
    for p in points {
        out = Some(match out {
            None => [p[0], p[1], p[0], p[1]],
            Some(r) => [r[0].min(p[0]), r[1].min(p[1]), r[2].max(p[0]), r[3].max(p[1])],
        });
    }
    out
}
pub(super) fn union(a: Option<Rect>, b: Option<Rect>) -> Option<Rect> {
    match (a, b) {
        (Some(a), Some(b)) => Some([a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]),
        (a, b) => a.or(b),
    }
}
/// Inclusive overlap: a zero-area line lying on the clip edge still counts.
pub(super) fn intersects(a: &Rect, b: &Rect) -> bool {
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}
pub(super) fn rect_corners(r: &Rect) -> [Point; 4] {
    [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]
}
pub(super) fn unit_square_corners(m: &[f64; 6]) -> [Point; 4] {
    rect_corners(&[0., 0., 1., 1.]).map(|p| apply(m, p))
}
/// A single closed axis-aligned rectangle in construction space (the `re`
/// operator, or an explicit move/three lines/close, optionally with a
/// returning line). Anything else is not a rectangle for clip purposes.
pub(super) fn rectangle_path(commands: &[f64]) -> Option<Rect> {
    let ops: Vec<u8> = opcodes(commands).collect();
    let points: Vec<Point> = path_points(commands).collect();
    let closed_by_line = (ops.len() == 5 && ops[4] == 1) || (ops.len() == 6 && ops[4] == 1 && ops[5] == 4);
    let plain = ops.len() == 5 && ops[4] == 4;
    if !(plain || closed_by_line) || ops[0] != 0 || ops[1..4] != [1, 1, 1] {
        return None;
    }
    if closed_by_line && points.get(4) != points.first() {
        return None;
    }
    let corners = &points[..4];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in corners {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    if x0 == x1 || y0 == y1 {
        return None;
    }
    // Each corner sits on the box boundary and consecutive corners share an axis.
    for i in 0..4 {
        let (a, b) = (corners[i], corners[(i + 1) % 4]);
        if !(a[0] == x0 || a[0] == x1) || !(a[1] == y0 || a[1] == y1) || (a[0] != b[0] && a[1] != b[1]) {
            return None;
        }
    }
    let distinct = corners.iter().all(|a| corners.iter().filter(|b| *b == a).count() == 1);
    distinct.then_some([x0, y0, x1, y1])
}
/// A transformed rectangle (any non-singular affine gives a parallelogram)
/// contains every corner of `rect`, so clipping to it removes nothing visible.
pub(super) fn quad_contains_rect(quad: &[Point; 4], rect: &Rect) -> bool {
    let cross = |a: Point, b: Point, c: Point| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let orientation = cross(quad[0], quad[1], quad[2]);
    if !orientation.is_finite() || orientation == 0. {
        return false;
    }
    let magnitude = quad
        .iter()
        .flatten()
        .chain(rect.iter())
        .fold(1_f64, |m, v| m.max(v.abs()));
    let epsilon = 1e-9 * magnitude * magnitude;
    rect_corners(rect).iter().all(|p| {
        (0..4).all(|i| cross(quad[i], quad[(i + 1) % 4], *p) * orientation.signum() >= -epsilon)
    })
}
