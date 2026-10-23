// SPDX-License-Identifier: MPL-2.0
use super::*;

/// 2D point pool with tolerance merging: canonical 3D/normal = first-seen.
/// Merging kills the 1e-12 doublets a cutter-edge junction produces when two
/// faces' clips compute the same geometric point through different arithmetic.
pub(super) struct PointPool {
    pub(super) pts2: Vec<Point2<f64>>,
    pub(super) pts3: Vec<V3>,
    pub(super) nrm: Vec<V3>,
    pub(super) buckets: FxHashMap<(i64, i64), Vec<usize>>,
    pub(super) eps: f64,
}

impl PointPool {
    pub(super) fn new(eps: f64) -> Self {
        Self {
            pts2: Vec::new(),
            pts3: Vec::new(),
            nrm: Vec::new(),
            buckets: FxHashMap::default(),
            eps: eps.max(1.0e-15),
        }
    }
    pub(super) fn intern(&mut self, q: V2, p3: V3, n: V3) -> usize {
        let cell = |x: f64| (x / (self.eps * 4.0)).floor() as i64;
        let (cx, cy) = (cell(q[0]), cell(q[1]));
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(ids) = self.buckets.get(&(cx + dx, cy + dy)) {
                    for &i in ids {
                        let d0 = self.pts2[i].x - q[0];
                        let d1 = self.pts2[i].y - q[1];
                        if d0.abs() <= self.eps && d1.abs() <= self.eps {
                            return i;
                        }
                    }
                }
            }
        }
        let idx = self.pts2.len();
        self.pts2.push(Point2::new(q[0], q[1]));
        self.pts3.push(p3);
        self.nrm.push(n);
        self.buckets.entry((cx, cy)).or_default().push(idx);
        idx
    }
}

/// Decompose one host triangle by the cutter-boundary seams via a conforming
/// per-triangle CDT; classify each sub-triangle by its centroid; record the
/// seams (with face-local 2D coords) for the cap builder. Returns false when
/// the CDT cannot be built (→ exact kernel for the whole opening).
#[allow(clippy::too_many_arguments)]
pub(super) fn decompose_tri(
    t: &PTri,
    pf: &PrismFrame,
    faces: &[Face],
    segs: &[(usize, V3, V3)],
    edge_pts: &[Vec<V3>; 3],
    out: &mut Vec<PTri>,
    inside: &mut Vec<PTri>,
    seams: &mut [Vec<Seam>],
) -> bool {
    // 2D basis in the triangle's plane (CCW = triangle winding).
    let Some(u) = normalize(sub(t.p[1], t.p[0])) else {
        out.push(t.clone());
        return true;
    };
    let Some(w) = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))) else {
        out.push(t.clone());
        return true;
    };
    let v = cross(w, u);
    let to2 = |x: V3| -> V2 {
        let d = sub(x, t.p[0]);
        [dot(d, u), dot(d, v)]
    };

    let mut mag = 0.0f64;
    for p in &t.p {
        for c in p {
            mag = mag.max(c.abs());
        }
    }
    let mut pool = PointPool::new(1.0e-9 * (1.0 + mag));

    let tri_idx = [
        pool.intern(to2(t.p[0]), t.p[0], t.n[0]),
        pool.intern(to2(t.p[1]), t.p[1], t.n[1]),
        pool.intern(to2(t.p[2]), t.p[2], t.n[2]),
    ];

    let mut segments: Vec<(usize, usize)> = Vec::new();
    // T-edge chains subdivided at the admitted crossing points.
    for e in 0..3 {
        let a3 = t.p[e];
        let b3 = t.p[(e + 1) % 3];
        let dir = sub(b3, a3);
        let len2 = dot(dir, dir);
        if len2 <= 0.0 {
            continue;
        }
        let mut on_edge: Vec<(f64, usize)> = Vec::new();
        for p in &edge_pts[e] {
            // Normal interpolated along the edge.
            let tt = (dot(sub(*p, a3), dir) / len2).clamp(0.0, 1.0);
            let nn = lerp(t.n[e], t.n[(e + 1) % 3], tt);
            let idx = pool.intern(to2(*p), *p, nn);
            on_edge.push((tt, idx));
        }
        on_edge.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = tri_idx[e];
        for &(_, idx) in &on_edge {
            if idx != prev {
                segments.push((prev, idx));
                prev = idx;
            }
        }
        let last = tri_idx[(e + 1) % 3];
        if last != prev {
            segments.push((prev, last));
        }
    }
    // Seam constraints (+ record for the cap builder). Interior seam points
    // carry the triangle's geometric normal (flat-facet hosts: exact).
    let face_n = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))).unwrap_or(w);
    for &(fi, a3, b3) in segs {
        let ia = pool.intern(to2(a3), a3, face_n);
        let ib = pool.intern(to2(b3), b3, face_n);
        if ia == ib {
            continue;
        }
        segments.push((ia, ib));
        seams[fi].push(Seam {
            a3,
            b3,
            a2: face_coords(pf, faces[fi], a3),
            b2: face_coords(pf, faces[fi], b3),
        });
    }
    segments.sort();
    segments.dedup();
    let t0 = t.p[0];
    // `resolve_crossings` interns any new seam×seam / T-junction points with a
    // placeholder [0,0,1] normal. These points land on the RETAINED host
    // surface (`out`), so a Z-up placeholder on a non-horizontal face shades
    // wrong. Overwrite every point it created with the host triangle's own
    // face normal.
    let existing_points = pool.nrm.len();
    resolve_crossings(
        &mut pool,
        |q| add(t0, add(scale(u, q[0]), scale(v, q[1]))),
        &mut segments,
    );
    for n in pool.nrm.iter_mut().skip(existing_points) {
        *n = face_n;
    }

    let Some((pts2, idx2)) = triangulate_pslg(&pool.pts2, &segments) else {
        return false;
    };
    if pts2.len() != pool.pts2.len() {
        return false; // CDT must not invent points — mapping back requires identity
    }

    for tri in idx2.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let p = [pool.pts3[a], pool.pts3[b], pool.pts3[c]];
        let centroid = scale(add(add(p[0], p[1]), p[2]), 1.0 / 3.0);
        let piece = PTri {
            p,
            n: [pool.nrm[a], pool.nrm[b], pool.nrm[c]],
        };
        if pf.contains(centroid) {
            inside.push(piece);
        } else {
            out.push(piece);
        }
    }
    true
}
