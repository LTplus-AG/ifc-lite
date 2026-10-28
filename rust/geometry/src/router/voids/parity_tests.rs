// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ROUTER-8 / #7781: original bodies remain independent of the shared helper.
use super::*;

fn legacy_nalgebra(
    origin: Point3<f64>,
    dir: &Vector3<f64>,
    a: Point3<f64>,
    b: Point3<f64>,
    c: Point3<f64>,
) -> Option<f64> {
    const EPS: f64 = 1e-9;
    let e1 = b - a;
    let e2 = c - a;
    let pvec = dir.cross(&e2);
    let det = e1.dot(&pvec);
    if det.abs() < EPS {
        return None; // ray parallel to the triangle plane
    }
    let inv_det = 1.0 / det;
    let tvec = origin - a;
    let u = tvec.dot(&pvec) * inv_det;
    if !(-EPS..=1.0 + EPS).contains(&u) {
        return None;
    }
    let qvec = tvec.cross(&e1);
    let v = dir.dot(&qvec) * inv_det;
    if v < -EPS || u + v > 1.0 + EPS {
        return None;
    }
    Some(e2.dot(&qvec) * inv_det)
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[allow(non_snake_case)]
fn legacy_array(point: V3, RAY_DIR: V3, a: V3, b: V3, c: V3) -> Option<f64> {
    struct Triangle {
        p: [V3; 3],
    }
    for t in [Triangle { p: [a, b, c] }] {
        let e1 = sub(t.p[1], t.p[0]);
        let e2 = sub(t.p[2], t.p[0]);
        let pvec = cross(RAY_DIR, e2);
        let det = dot(e1, pvec);
        if det.abs() < 1.0e-12 {
            continue;
        }
        let inv = 1.0 / det;
        let tvec = sub(point, t.p[0]);
        let u = dot(tvec, pvec) * inv;
        if !(-1.0e-9..=1.0 + 1.0e-9).contains(&u) {
            continue;
        }
        let qvec = cross(tvec, e1);
        let v = dot(RAY_DIR, qvec) * inv;
        if v < -1.0e-9 || u + v > 1.0 + 1.0e-9 {
            continue;
        }
        let dist = dot(e2, qvec) * inv;
        return Some(dist);
    }
    None
}

struct Stream(u64);
impl Stream {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        let unit = (self.0 >> 11) as f64 / (1u64 << 53) as f64;
        match self.0 % 11 {
            0 => 0.0,
            1 => -0.0,
            2 => (unit - 0.5) * 2.0e6,
            3 => (unit - 0.5) * 1.0e-6,
            _ => (unit - 0.5) * 20.0,
        }
    }
    fn v(&mut self) -> V3 {
        [self.next(), self.next(), self.next()]
    }
}

fn compare(o: V3, d: V3, a: V3, b: V3, c: V3) -> bool {
    let mesh = legacy_nalgebra(o.into(), &d.into(), a.into(), b.into(), c.into());
    let prism = legacy_array(o, d, a, b, c);
    for (old, det_eps) in [(mesh, 1e-9), (prism, 1e-12)] {
        assert_eq!(
            old.map(f64::to_bits),
            ray_triangle_param(o, d, a, b, c, det_eps, 1e-9).map(f64::to_bits),
            "o={o:?} d={d:?} triangle={:?} det_eps={det_eps}",
            [a, b, c]
        );
    }
    mesh.is_some()
}

#[test]
fn c2_5b_ray_seeded_bits_match_both_legacy_callers() {
    let mut s = Stream(0x9E37_79B9_7F4A_7C15);
    let mut hits = 0;
    for i in 0..200_000 {
        let (mut o, a, b, c) = (s.v(), s.v(), s.v(), s.v());
        let d: V3 = if i % 2 == 0 {
            PARITY_DIR_A.into()
        } else {
            s.v()
        };
        if i % 3 == 0 {
            for k in 0..3 {
                o[k] = a[k] * 0.2 + b[k] * 0.3 + c[k] * 0.5 - d[k] * 3.0;
            }
        }
        hits += usize::from(compare(o, d, a, b, c));
    }
    assert!(hits > 10_000, "hit coverage: {hits}");
}

#[test]
fn c2_5b_ray_thresholds_degenerate_nonfinite_and_signed_zero() {
    let around = |x: f64| [x.next_down(), x, x.next_up()];
    for z in [0.0, -0.0, 5.0e6] {
        let (a, b, c) = ([0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]);
        for det in [1e-9, 1e-12] {
            for dz in around(det).into_iter().chain(around(-det)) {
                compare([0.2, 0.3, z - 1.0], [0.0, -0.0, dz], a, b, c);
            }
        }
        for edge in [-1e-9, 0.0, 1.0, 1.0 + 1e-9] {
            for u in around(edge) {
                for v in [-1e-9, 0.0, 0.3, 1.0 - u + 1e-9] {
                    compare([u, v, z - 1.0], [0.0, 0.0, 1.0], a, b, c);
                }
            }
        }
        for d in [[0.0; 3], [-0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]] {
            compare([0.2, 0.3, z], d, a, b, c);
            compare([0.2, 0.3, z], d, a, a, a);
            compare([0.2, 0.3, z], d, a, b, b);
        }
        for special in [f64::NAN, -f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for which in 0..5 {
                for axis in 0..3 {
                    let mut args = [[0.2, 0.3, z - 1.0], [0.0, 0.0, 1.0], a, b, c];
                    args[which][axis] = special;
                    compare(args[0], args[1], args[2], args[3], args[4]);
                }
            }
        }
    }
}

// #7781 R3 / ROUTER-8: both former f64 literal spellings have these exact bits.
#[test]
fn c2_5_finish_shared_ray_keeps_both_legacy_directions() {
    let legacy_array: V3 = [0.573_257_1, 0.665_412_3, 0.477_889_5];
    let legacy_vector = Vector3::<f64>::new(0.573_257_1, 0.665_412_3, 0.477_889_5);
    assert_eq!(PARITY_RAY_DIR.map(f64::to_bits), legacy_array.map(f64::to_bits));
    let vector: V3 = PARITY_DIR_A.into();
    let legacy: V3 = legacy_vector.into();
    assert_eq!(vector.map(f64::to_bits), legacy.map(f64::to_bits));
    assert_eq!(vector.map(f64::to_bits), PARITY_RAY_DIR.map(f64::to_bits));
}
