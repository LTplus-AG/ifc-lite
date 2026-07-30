// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ulp-scale unification of the analytic cut's new vertices.
//!
//! Split out of `prism_cut.rs` to keep it under the module-size ratchet.

use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

/// Make the analytic cut's NEW vertices unique at ulp scale.
///
/// The cut derives a crossing point once per (host face, cutter plane) pair. Two
/// host faces that share an edge therefore compute the SAME geometric point
/// through different arithmetic and can land a float ulp apart. The two halves of
/// the split face then fail to share their seam, which is an unmatched half-edge
/// pair and renders as a hairline crack.
///
/// `dental_clinic #217` is the minimal case. The host arriving here is clean: 12
/// triangles, a single `x = -20.29`. The cut emits the mid-height seam at both
/// `x = -20.289999008` and `x = -20.290000916` — exactly 2^-19 apart — giving 8
/// unmatched edges.
///
/// Deliberately narrow, because a general weld is what broke this before: merging
/// at 1e-4 m collapsed real geometry and took corpus defects from 76 to 90. Here
/// the tolerance is 4 f32 ulps of the coordinate magnitude, which is below any
/// real feature and above the reconstruction scatter. Vertices that coincide with
/// a HOST vertex are pinned to the host value exactly, so the cut cannot move a
/// vertex it did not create; the rest are merged only with each other.
pub(crate) fn dedup_cut_vertices(cut: &Mesh, host: &Mesh) -> Mesh {
    let cn = cut.positions.len() / 3;
    if cn == 0 {
        return cut.clone();
    }
    let mut mag = 1.0f32;
    for &c in host.positions.iter().chain(cut.positions.iter()) {
        mag = mag.max(c.abs());
    }
    let tol = (mag as f64) * (4.0 / 8_388_608.0);
    let tol2 = tol * tol;
    let cell = (tol * 4.0).max(f64::MIN_POSITIVE);
    let key = |p: [f64; 3]| {
        [
            (p[0] / cell).floor() as i64,
            (p[1] / cell).floor() as i64,
            (p[2] / cell).floor() as i64,
        ]
    };
    let d2 = |a: [f64; 3], b: [f64; 3]| {
        let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    };

    // Host vertices seed the pool, so any cut vertex within tolerance of one is
    // pinned to the host's exact value rather than becoming its own
    // representative.
    let mut pool: FxHashMap<[i64; 3], Vec<[f64; 3]>> = FxHashMap::default();
    for i in 0..host.positions.len() / 3 {
        let p = [
            host.positions[i * 3] as f64,
            host.positions[i * 3 + 1] as f64,
            host.positions[i * 3 + 2] as f64,
        ];
        pool.entry(key(p)).or_default().push(p);
    }

    let mut out = cut.clone();
    for i in 0..cn {
        let p = [
            out.positions[i * 3] as f64,
            out.positions[i * 3 + 1] as f64,
            out.positions[i * 3 + 2] as f64,
        ];
        let base = key(p);
        let mut best: Option<(f64, [f64; 3])> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(b) = pool.get(&[base[0] + dx, base[1] + dy, base[2] + dz]) {
                        for q in b {
                            let dd = d2(p, *q);
                            if dd <= tol2 && best.map(|(x, _)| dd < x).unwrap_or(true) {
                                best = Some((dd, *q));
                            }
                        }
                    }
                }
            }
        }
        match best {
            Some((_, q)) => {
                out.positions[i * 3] = q[0] as f32;
                out.positions[i * 3 + 1] = q[1] as f32;
                out.positions[i * 3 + 2] = q[2] as f32;
            }
            None => pool.entry(base).or_default().push(p),
        }
    }
    out
}
