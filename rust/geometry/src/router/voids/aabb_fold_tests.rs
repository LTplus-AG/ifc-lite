// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ROUTER-11 / #7781: each legacy fold below is copied verbatim from 6e26fe7eae.
// These tests isolate the fold's operands from the strategy's admission gates,
// exercising NaNs/empty inputs even where a caller normally rejects them first.
// Axis interleaving is independent; the sequence seen by each accumulator is fixed.
use super::{dot, sub, Aabb3, Mesh, PTri, PrismFrame};
use crate::math::aabb::Aabb3f32;
use crate::{Point3, Vector3};

type Bounds = ([f64; 3], [f64; 3]);

fn assert_bits(expected: Bounds, actual: Bounds) {
    assert_eq!(expected.0.map(f64::to_bits), actual.0.map(f64::to_bits));
    assert_eq!(expected.1.map(f64::to_bits), actual.1.map(f64::to_bits));
}

fn assert_bits32(expected: ([f32; 3], [f32; 3]), actual: ([f32; 3], [f32; 3])) {
    assert_eq!(expected.0.map(f32::to_bits), actual.0.map(f32::to_bits));
    assert_eq!(expected.1.map(f32::to_bits), actual.1.map(f32::to_bits));
}

fn cases() -> Vec<Vec<[f64; 3]>> {
    let mut cases = vec![
        vec![],
        vec![[0.0; 3]],
        vec![[-0.0; 3]],
        vec![[0.0; 3], [-0.0; 3]],
        vec![[-0.0; 3], [0.0; 3]],
        vec![[5.0e12, -7.0e12, 9.0e12]],
        vec![[f64::NAN; 3]],
        vec![[f64::INFINITY; 3]],
        vec![[f64::NEG_INFINITY; 3]],
    ];
    let edges = [
        0.0,
        -0.0,
        f64::NAN,
        f64::from_bits(0xfff8_0000_0000_1234),
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::MAX,
        f64::MIN,
        1.0e-300,
        -1.0e-300,
    ];
    for &a in &edges {
        for &b in &edges {
            cases.push(vec![[a, b, a], [b, a, b], [a, b, b]]);
        }
    }
    let mut state = 0x7781_c25c_09ab_1234u64;
    for count in 0..1024 {
        let points = (0..count % 33)
            .map(|_| {
                std::array::from_fn(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    if state.is_multiple_of(7) {
                        edges[state as usize % edges.len()]
                    } else {
                        (state as i64 as f64) * 1.0e-9
                    }
                })
            })
            .collect();
        cases.push(points);
    }
    cases
}

fn mesh(points: &[[f64; 3]]) -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = points.iter().flatten().map(|&v| v as f32).collect();
    // Both implementations must ignore incomplete xyz tails.
    mesh.positions.extend([f32::NAN, -0.0]);
    mesh
}

fn triangles(points: &[[f64; 3]]) -> Vec<PTri> {
    points
        .chunks(3)
        .map(|p| PTri {
            p: std::array::from_fn(|k| p[k % p.len()]),
            n: [[0.0; 3]; 3],
        })
        .collect()
}

// rust/geometry/src/router/voids/frame_project.rs:69; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_frame_project_legacy_bits() {
    for points in cases() {
        let mesh = mesh(&points);
        let center = Vector3::new(5.0e6, -0.0, -2.0);
        let axes = [Vector3::x(), Vector3::y(), Vector3::new(0.3, -0.5, 0.8)];
        let expected = {
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for ch in mesh.positions.chunks_exact(3) {
                let p = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64) - center;
                for k in 0..3 {
                    let v = p.dot(&axes[k]);
                    lo[k] = lo[k].min(v);
                    hi[k] = hi[k].max(v);
                }
            }
            (lo, hi)
        };
        let actual = {
            let bounds = Aabb3::from_points(mesh.positions.chunks_exact(3).map(|ch| {
                let p = Vector3::new(ch[0] as f64, ch[1] as f64, ch[2] as f64) - center;
                std::array::from_fn(|k| p.dot(&axes[k]))
            }));
            let (lo, hi) = (bounds.min, bounds.max);
            (lo, hi)
        };
        assert_bits(expected, actual);
        let projected = super::super::geom::project_aabb_in_frame(&mesh, &axes, center);
        if expected.0.iter().chain(&expected.1).all(|v| v.is_finite()) {
            let (lo, hi) = projected.expect("finite legacy projection");
            assert_bits(expected, (lo.into(), hi.into()));
        } else {
            assert!(projected.is_none());
        }
    }
}

// rust/geometry/src/router/voids/mod.rs:295; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_param_host_legacy_bits() {
    for points in cases() {
        let host_f = mesh(&points);
        let expected = {
            let mut hmn = [f64::INFINITY; 3];
            let mut hmx = [f64::NEG_INFINITY; 3];
            for c in host_f.positions.chunks_exact(3) {
                for k in 0..3 {
                    hmn[k] = hmn[k].min(c[k] as f64);
                    hmx[k] = hmx[k].max(c[k] as f64);
                }
            }
            (hmn, hmx)
        };
        let actual = {
            let bounds = Aabb3::from_f32_positions(&host_f.positions);
            let (hmn, hmx) = (bounds.min, bounds.max);
            (hmn, hmx)
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/synthesis.rs:90; f64, first box (a_min/a_max).
#[test]
fn c2_5c_rect_union_legacy_bits() {
    for points in cases() {
        let a_min: Point3<f64> = points.first().copied().unwrap_or([0.0; 3]).into();
        let a_max: Point3<f64> = points.last().copied().unwrap_or([0.0; 3]).into();
        let b_min = a_max;
        let b_max = a_min;
        let i = 0;
        let dir: Option<Vector3<f64>> = None;
        let expected = {
            let mut rects = [(a_min, a_max, dir)];
            rects[i] = (
                Point3::new(
                    a_min.x.min(b_min.x),
                    a_min.y.min(b_min.y),
                    a_min.z.min(b_min.z),
                ),
                Point3::new(
                    a_max.x.max(b_max.x),
                    a_max.y.max(b_max.y),
                    a_max.z.max(b_max.z),
                ),
                dir,
            );
            (rects[i].0.into(), rects[i].1.into())
        };
        let actual = {
            let mut rects = [(a_min, a_max, dir)];
            let bounds = Aabb3 {
                min: a_min.into(),
                max: a_max.into(),
            }
            .union(&Aabb3 {
                min: b_min.into(),
                max: b_max.into(),
            });
            rects[i] = (bounds.min.into(), bounds.max.into(), dir);
            (rects[i].0.into(), rects[i].1.into())
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/synthesis.rs:312; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_extended_points_legacy_bits() {
    for points in cases() {
        let all_points: Vec<Point3<f64>> = points.iter().copied().map(Into::into).collect();
        let expected = {
            let new_min = Point3::new(
                all_points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min),
                all_points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min),
                all_points.iter().map(|p| p.z).fold(f64::INFINITY, f64::min),
            );
            let new_max = Point3::new(
                all_points
                    .iter()
                    .map(|p| p.x)
                    .fold(f64::NEG_INFINITY, f64::max),
                all_points
                    .iter()
                    .map(|p| p.y)
                    .fold(f64::NEG_INFINITY, f64::max),
                all_points
                    .iter()
                    .map(|p| p.z)
                    .fold(f64::NEG_INFINITY, f64::max),
            );
            (new_min.into(), new_max.into())
        };
        let actual = {
            let bounds = Aabb3::from_points(all_points.iter().map(|p| (*p).into()));
            let (new_min, new_max): (Point3<f64>, Point3<f64>) =
                (bounds.min.into(), bounds.max.into());
            (new_min.into(), new_max.into())
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/malformed_opening_repair.rs:221; f64, MAX/MIN (finite).
#[test]
fn c2_5c_malformed_projection_legacy_bits() {
    for points in cases() {
        let inliers: Vec<Vector3<f64>> = points.iter().copied().map(Into::into).collect();
        let axes = [Vector3::x(), Vector3::y(), Vector3::new(0.3, -0.5, 0.8)];
        let expected = {
            let mut lo = [f64::MAX; 3];
            let mut hi = [f64::MIN; 3];
            for v in &inliers {
                for k in 0..3 {
                    let t = v.dot(&axes[k]);
                    lo[k] = lo[k].min(t);
                    hi[k] = hi[k].max(t);
                }
            }
            (lo, hi)
        };
        let actual = {
            let mut bounds = Aabb3 {
                min: [f64::MAX; 3],
                max: [f64::MIN; 3],
            };
            for v in &inliers {
                bounds.extend(std::array::from_fn(|k| v.dot(&axes[k])));
            }
            let (lo, hi) = (bounds.min, bounds.max);
            (lo, hi)
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/parity.rs:231; f32, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_containment_inset_legacy_bits() {
    for points in cases() {
        let host = mesh(&points);
        let expected = {
            let mut mn = [f32::INFINITY; 3];
            let mut mx = [f32::NEG_INFINITY; 3];
            for v in host.positions.chunks_exact(3) {
                mn[0] = mn[0].min(v[0]);
                mx[0] = mx[0].max(v[0]);
                mn[1] = mn[1].min(v[1]);
                mx[1] = mx[1].max(v[1]);
                mn[2] = mn[2].min(v[2]);
                mx[2] = mx[2].max(v[2]);
            }
            (mn, mx)
        };
        let actual = {
            let bounds = Aabb3f32::from_positions(&host.positions);
            let (mn, mx) = (bounds.min, bounds.max);
            (mn, mx)
        };
        assert_bits32(expected, actual);
    }
}

// rust/geometry/src/router/voids/sweep.rs:165; f32, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_component_vertices_legacy_bits() {
    for points in cases() {
        let mesh = mesh(&points);
        let expected = {
            let mut pair = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            let entry = &mut pair;
            for b in (0..points.len() * 3).step_by(3) {
                for k in 0..3 {
                    entry.0[k] = entry.0[k].min(mesh.positions[b + k]);
                    entry.1[k] = entry.1[k].max(mesh.positions[b + k]);
                }
            }
            pair
        };
        let actual = {
            let mut pair = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            let entry = &mut pair;
            for b in (0..points.len() * 3).step_by(3) {
                let mut bounds = Aabb3f32 {
                    min: entry.0,
                    max: entry.1,
                };
                bounds.extend([
                    mesh.positions[b],
                    mesh.positions[b + 1],
                    mesh.positions[b + 2],
                ]);
                *entry = (bounds.min, bounds.max);
            }
            pair
        };
        assert_bits32(expected, actual);
    }
}

// rust/geometry/src/router/voids/synthesis/host_vertices.rs:162; f32, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_host_vertex_reject_legacy_bits() {
    for points in cases() {
        let cutter = mesh(&points);
        let expected = {
            let (mut flo, mut fhi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            for p in cutter.positions.chunks_exact(3) {
                for k in 0..3 {
                    flo[k] = flo[k].min(p[k]);
                    fhi[k] = fhi[k].max(p[k]);
                }
            }
            (flo, fhi)
        };
        let actual = {
            let bounds = Aabb3f32::from_positions(&cutter.positions);
            let (flo, fhi) = (bounds.min, bounds.max);
            (flo, fhi)
        };
        assert_bits32(expected, actual);
    }
}

// rust/geometry/src/router/voids/synthesis/membrane.rs:58; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_membrane_axis_legacy_bits() {
    for points in cases() {
        let opening_mesh = mesh(&points);
        let expected = {
            let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            for c in opening_mesh.positions.chunks_exact(3) {
                for a in 0..3 {
                    lo[a] = lo[a].min(c[a] as f64);
                    hi[a] = hi[a].max(c[a] as f64);
                }
            }
            (lo, hi)
        };
        let actual = {
            let bounds = Aabb3::from_f32_positions(&opening_mesh.positions);
            let (lo, hi) = (bounds.min, bounds.max);
            (lo, hi)
        };
        assert_bits(expected, actual);
    }
}

impl PTri {
    fn legacy_aabb_c2_5c(&self) -> Bounds {
        let mut lo = self.p[0];
        let mut hi = self.p[0];
        for v in &self.p[1..] {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
        (lo, hi)
    }
}

#[test]
fn c2_5c_triangle_bounds_legacy_bits() {
    for points in cases() {
        for tri in triangles(&points) {
            assert_bits(tri.legacy_aabb_c2_5c(), tri.aabb());
        }
    }
}

// rust/geometry/src/router/voids/prism_cut.rs:356; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_partition_bounds_legacy_bits() {
    for points in cases() {
        let pairs: Vec<([f64; 3], [f64; 3])> =
            points.chunks(2).map(|p| (p[0], p[p.len() - 1])).collect();
        let bounds = &pairs;
        let expected = {
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for (a, b) in bounds {
                for k in 0..3 {
                    lo[k] = lo[k].min(a[k]);
                    hi[k] = hi[k].max(b[k]);
                }
            }
            (lo, hi)
        };
        let actual = {
            let mut envelope = Aabb3::EMPTY;
            for &(min, max) in bounds {
                envelope = envelope.union(&Aabb3 { min, max });
            }
            let (lo, hi) = (envelope.min, envelope.max);
            (lo, hi)
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/prism_cut.rs:413; f64, +0.0/+0.0.
#[test]
fn c2_5c_face_envelope_legacy_bits() {
    for points in cases() {
        let faces = triangles(&points);
        let origin = [5.0e6, -0.0, -2.0];
        let axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.3, -0.5, 0.8]];
        let expected = {
            let mut lo = [0.0f64; 3];
            let mut hi = [0.0f64; 3];
            for t in &faces {
                for p in t.p {
                    for k in 0..3 {
                        let coordinate = dot(sub(p, origin), axes[k]);
                        lo[k] = lo[k].min(coordinate);
                        hi[k] = hi[k].max(coordinate);
                    }
                }
            }
            (lo, hi)
        };
        let actual = {
            let mut bounds = Aabb3 {
                min: [0.0; 3],
                max: [0.0; 3],
            };
            for t in &faces {
                for p in t.p {
                    bounds.extend(std::array::from_fn(|k| dot(sub(p, origin), axes[k])));
                }
            }
            let (lo, hi) = (bounds.min, bounds.max);
            (lo, hi)
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/prism_cut.rs:2741; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_prism_host_projection_legacy_bits() {
    for points in cases() {
        let tris = triangles(&points);
        let axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.3, -0.5, 0.8]];
        let expected = {
            let mut hlo = [f64::INFINITY; 3];
            let mut hhi = [f64::NEG_INFINITY; 3];
            for t in &tris {
                for p in &t.p {
                    for k in 0..3 {
                        let s = dot(*p, axes[k]);
                        hlo[k] = hlo[k].min(s);
                        hhi[k] = hhi[k].max(s);
                    }
                }
            }
            (hlo, hhi)
        };
        let actual = {
            let bounds = Aabb3::from_points(
                tris.iter()
                    .flat_map(|t| t.p.iter())
                    .map(|p| std::array::from_fn(|k| dot(*p, axes[k]))),
            );
            let (hlo, hhi) = (bounds.min, bounds.max);
            (hlo, hhi)
        };
        assert_bits(expected, actual);
    }
}

// rust/geometry/src/router/voids/prism_cut.rs:2768; f64, INFINITY/NEG_INFINITY.
#[test]
fn c2_5c_committed_prism_legacy_bits() {
    for points in cases() {
        let p = points.first().copied().unwrap_or([0.0; 3]);
        let q = points.last().copied().unwrap_or([0.0; 3]);
        let pf = PrismFrame {
            u: [1.0, 0.0, 0.0],
            v: [0.0, 0.6, -0.8],
            d: [0.0, 0.8, 0.6],
            planes: vec![p[2], q[2]],
            profiles: vec![],
            slab_area: vec![],
            slab_interior: vec![],
            bb: ([p[0], p[1]], [q[0], q[1]]),
        };
        let expected = {
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for &uu in &[pf.bb.0[0], pf.bb.1[0]] {
                for &vv in &[pf.bb.0[1], pf.bb.1[1]] {
                    for &w in &[pf.d0(), pf.d1()] {
                        let p = pf.lift(uu, vv, w);
                        for k in 0..3 {
                            lo[k] = lo[k].min(p[k]);
                            hi[k] = hi[k].max(p[k]);
                        }
                    }
                }
            }
            (lo, hi)
        };
        let actual = {
            let mut bounds = Aabb3::EMPTY;
            for &uu in &[pf.bb.0[0], pf.bb.1[0]] {
                for &vv in &[pf.bb.0[1], pf.bb.1[1]] {
                    for &w in &[pf.d0(), pf.d1()] {
                        bounds.extend(pf.lift(uu, vv, w));
                    }
                }
            }
            let (lo, hi) = (bounds.min, bounds.max);
            (lo, hi)
        };
        assert_bits(expected, actual);
    }
}

#[test]
fn c2_5c_f32_extent_is_not_widened() {
    let b = Aabb3f32::from_positions(&[-f32::MAX, 0.0, 0.0, f32::MAX, 0.0, 0.0]);
    assert!((b.max[0] - b.min[0]).is_infinite());
    assert!(((b.max[0] as f64) - (b.min[0] as f64)).is_finite());
}
