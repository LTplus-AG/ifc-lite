// SPDX-License-Identifier: MPL-2.0
//! Green integrals of exact line/arc boundaries clipped by half-planes.
//! No sampling, triangulation, mesh CSG or display coordinates participate.
use std::f64::consts::TAU;
type Point = [f64; 2];
fn cross(a: Point, b: Point) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}
#[derive(Clone, Debug)]
pub(super) enum Edge {
    Line(Point, Point),
    // Parametric circular arc after placement (affine frames can give ellipses).
    Arc {
        c: Point,
        u: Point,
        v: Point,
        a: f64,
        sweep: f64,
    },
}
impl Edge {
    pub fn point(&self, t: f64) -> Point {
        match *self {
            Self::Line(a, b) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
            Self::Arc { c, u, v, a, sweep } => {
                let (s, co) = (a + t * sweep).sin_cos();
                [c[0] + u[0] * co + v[0] * s, c[1] + u[1] * co + v[1] * s]
            }
        }
    }
    fn portion(&self, t: f64, end: f64) -> Self {
        match *self {
            Self::Line(..) => Self::Line(self.point(t), self.point(end)),
            Self::Arc { c, u, v, a, sweep } => Self::Arc {
                c,
                u,
                v,
                a: a + t * sweep,
                sweep: (end - t) * sweep,
            },
        }
    }
    pub fn integral(&self) -> f64 {
        match *self {
            Self::Line(a, b) => cross(a, b) / 2.,
            Self::Arc { c, u, v, a, sweep } => {
                let b = a + sweep;
                // 1/2 integral (x dy - y dx): translation terms + det(u,v)*dtheta.
                (cross(c, u) * (b.cos() - a.cos())
                    + cross(c, v) * (b.sin() - a.sin())
                    + cross(u, v) * sweep)
                    / 2.
            }
        }
    }
    pub(super) fn split_parameters(&self, h: HalfPlane) -> Vec<f64> {
        let mut ts = vec![0., 1.];
        match *self {
            Self::Line(a, b) => {
                let (da, db) = (h.distance(a), h.distance(b));
                if da != db {
                    let t = da / (da - db);
                    if t > 0. && t < 1. {
                        ts.push(t);
                    }
                }
            }
            Self::Arc { c, u, v, a, sweep } => {
                // A cos(theta)+B sin(theta)+C=0; solve, never chord-approximate.
                let aa = h.n[0] * u[0] + h.n[1] * u[1];
                let bb = h.n[0] * v[0] + h.n[1] * v[1];
                let r = aa.hypot(bb);
                let q = -h.distance(c) / r;
                if r > 0. && (-1. ..=1.).contains(&q) {
                    let phi = bb.atan2(aa);
                    let delta = q.acos();
                    for root in [phi - delta, phi + delta] {
                        let lo = a.min(a + sweep);
                        let hi = a.max(a + sweep);
                        let first = ((lo - root) / TAU).ceil() as i64;
                        let last = ((hi - root) / TAU).floor() as i64;
                        for k in first..=last {
                            let t = (root + TAU * k as f64 - a) / sweep;
                            if t > 0. && t < 1. {
                                ts.push(t);
                            }
                        }
                    }
                }
            }
        }
        ts.sort_by(f64::total_cmp);
        ts.dedup();
        ts
    }
}
#[derive(Clone, Copy, Debug)]
pub(super) struct HalfPlane {
    pub(super) n: Point,
    pub(super) d: f64,
}
impl HalfPlane {
    pub(super) fn distance(self, p: Point) -> f64 {
        self.n[0] * p[0] + self.n[1] * p[1] + self.d
    }
}
pub(super) fn convex_planes(edges: &[Edge]) -> Option<Vec<HalfPlane>> {
    if edges.len() < 3 {
        return None;
    }
    let mut vertices = Vec::new();
    for edge in edges {
        if let Edge::Line(a, _) = edge {
            vertices.push(*a);
        } else {
            return None;
        }
    }
    let signed: f64 = edges.iter().map(Edge::integral).sum();
    if !signed.is_finite() || signed == 0. {
        return None;
    }
    let mut planes = Vec::new();
    for i in 0..vertices.len() {
        let a = vertices[i];
        let b = vertices[(i + 1) % vertices.len()];
        let d = sub(b, a);
        let norm = d[0].hypot(d[1]);
        if norm == 0. {
            return None;
        }
        let n = [
            -d[1] * signed.signum() / norm,
            d[0] * signed.signum() / norm,
        ];
        let h = HalfPlane {
            n,
            d: -n[0] * a[0] - n[1] * a[1],
        };
        if vertices.iter().any(|p| h.distance(*p) < -1e-10) {
            return None;
        }
        planes.push(h);
    }
    Some(planes)
}
pub(super) fn clipped_area(edges: &[Edge], planes: &[HalfPlane], work: &mut usize) -> Option<f64> {
    let mut boundary = edges.to_vec();
    for h in planes {
        *work = work.checked_sub(boundary.len())?;
        let mut kept = Vec::new();
        for edge in &boundary {
            for span in edge.split_parameters(*h).windows(2) {
                if h.distance(edge.point((span[0] + span[1]) / 2.)) >= 0. {
                    kept.push(edge.portion(span[0], span[1]));
                }
            }
        }
        boundary.clear();
        // Connect retained runs along the clipping line. Disconnected components
        // and holes are valid: oppositely directed bridge integrals cancel.
        for i in 0..kept.len() {
            boundary.push(kept[i].clone());
            let end = kept[i].point(1.);
            let next = kept[(i + 1) % kept.len()].point(0.);
            if end != next {
                boundary.push(Edge::Line(end, next));
            }
        }
    }
    Some(boundary.iter().map(Edge::integral).sum::<f64>().abs())
}
