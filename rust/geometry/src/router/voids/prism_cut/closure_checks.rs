// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh-closure predicates the analytic cut self-checks its output against.
//!
//! Split out of `prism_cut.rs` to keep it under the module-size ratchet.

use super::{dot, norm, normalize, scale, sub, V3};
use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

/// DIRECTED quantized closed-surface audit (0.1 mm grid): every directed edge
/// must be cancelled by its reverse. Strictly stronger than the undirected
/// 2-manifold check — it catches inconsistent winding and doubled coincident
/// surfaces (two triangles sharing an edge in the SAME direction), not just
/// cracks. Triangles that collapse to a degenerate key on the grid are skipped
/// (their edges net to zero).
pub(super) fn directed_closed(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: FxHashMap<((i64, i64, i64), (i64, i64, i64)), i64> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            *edges.entry((x, y)).or_insert(0) += 1;
            *edges.entry((y, x)).or_insert(0) -= 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 0)
}

/// Closed-surface audit with a HAIRLINE tolerance: the surface passes when
/// every unpaired directed edge (0.1 mm grid) is collinearly COVERED by
/// unpaired edges of the opposite net sign — the signature of two adjacent
/// faces subdividing a shared boundary line differently (a T-junction chain,
/// invisible sub-grid gap), NOT of a missing surface. A genuine hole leaves a
/// boundary loop whose edges have nothing opposite along them and fails. The
/// exact kernel's own output is routinely NOT even undirected-watertight on
/// these hosts, so this gate is still far stricter than the status quo.
pub(super) fn closed_or_hairline(mesh: &Mesh) -> bool {
    type K = (i64, i64, i64);
    let key = |i: u32| -> K {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: FxHashMap<(K, K), i64> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            *edges.entry((x, y)).or_insert(0) += 1;
            *edges.entry((y, x)).or_insert(0) -= 1;
        }
    }
    if edges.is_empty() {
        return false;
    }
    // Canonicalize to undirected segments with a net sign.
    //
    // Sorted by endpoint key, NOT left in `edges` iteration order: `FxHashMap`
    // iterates target-dependently, and the length sort below is not a total order,
    // so equal-length segments would seed the line grouping in an arbitrary order
    // that differs between native and wasm32. The grouping is greedy, so a
    // different seed can reach a different verdict. (Pre-existing; surfaced when
    // this moved out of `prism_cut.rs`.)
    let mut bad: Vec<(K, K, i64)> = Vec::new();
    for (&(a, b), &c) in edges.iter() {
        if c > 0 {
            bad.push((a, b, c));
        }
    }
    bad.sort_unstable_by_key(|&(a, b, _)| (a, b));
    if bad.is_empty() {
        return true;
    }
    if bad.len() > 64 {
        return false; // way past hairline territory
    }
    let p = |k: K| [k.0 as f64, k.1 as f64, k.2 as f64]; // grid units (0.1 mm)

    // Rigorous hairline test. A hairline (T-junction) boundary is one where the
    // uncancelled directed edges, viewed as a 1-D SIGNED measure along each
    // supporting line, net to ZERO everywhere: every stretch covered by an edge
    // running one way is covered the SAME number of times by edges running the
    // other way (two adjacent faces subdividing a shared line differently). A
    // genuine hole — or a boundary edge only PARTIALLY covered, or covered the
    // wrong number of times — leaves a stretch with nonzero net coverage and
    // fails. This is strictly stronger than the old midpoint-proximity test,
    // which a LONG unmatched edge could spoof merely by having a SHORT reverse
    // edge sit near its midpoint (the short edge "covered" a single point, never
    // the whole interval, and multiplicity was ignored entirely).
    const COLLINEAR_TOL: f64 = 2.0; // grid units (~0.2 mm) perpendicular slack
    const T_EPS: f64 = 1.0e-6; // grid units: ignore sub-interval slivers

    struct Seg {
        a: V3,
        b: V3,
        m: i64,
    }
    let segs: Vec<Seg> = bad
        .iter()
        .map(|&(a, b, c)| Seg {
            a: p(a),
            b: p(b),
            m: c,
        })
        .collect();

    // Perpendicular distance from point `x` to the infinite line `(o, dir)`
    // (`dir` unit). Perp distance is convex along a segment, so if BOTH
    // endpoints of a segment are within tol of a line, the whole segment is —
    // that is our collinearity-coincidence test (no separate parallel check
    // needed, and it correctly rejects a segment that merely crosses the line).
    let perp = |x: V3, o: V3, dir: V3| -> f64 {
        let w = sub(x, o);
        let along = dot(w, dir);
        norm(sub(w, scale(dir, along)))
    };

    struct Line {
        o: V3,
        dir: V3,
        members: Vec<usize>,
    }
    // Seed lines from the LONGEST segments first: a long edge fixes a stable
    // direction, so its collinear short neighbours join it rather than each
    // spawning a slightly-rotated line of its own (greedy fragmentation would
    // split a genuinely-covered boundary across groups and report phantom gaps).
    let mut order: Vec<usize> = (0..segs.len()).collect();
    order.sort_by(|&i, &j| {
        let li = dot(sub(segs[i].b, segs[i].a), sub(segs[i].b, segs[i].a));
        let lj = dot(sub(segs[j].b, segs[j].a), sub(segs[j].b, segs[j].a));
        // `total_cmp` + index tie-break: a total order, so the seed sequence is a
        // pure function of `bad` (already canonically sorted above).
        lj.total_cmp(&li).then(i.cmp(&j))
    });
    let mut lines: Vec<Line> = Vec::new();
    'seg: for si in order {
        let s = &segs[si];
        let Some(sdir) = normalize(sub(s.b, s.a)) else {
            // Degenerate (zero-length) bad edge: cannot seal anything → defer.
            return false;
        };
        for line in lines.iter_mut() {
            if perp(s.a, line.o, line.dir) <= COLLINEAR_TOL
                && perp(s.b, line.o, line.dir) <= COLLINEAR_TOL
            {
                line.members.push(si);
                continue 'seg;
            }
        }
        lines.push(Line {
            o: s.a,
            dir: sdir,
            members: vec![si],
        });
    }

    // Sweep each line's signed multiplicity coverage. At every point along the
    // line the signed count of covering edges (this line's `+dir` edges minus
    // its `-dir` edges, weighted by multiplicity) must net to ZERO — the exact
    // T-junction signature. We track the longest CONTIGUOUS mis-covered run and
    // reject once it exceeds `GAP_TOL`: a hole, a partially-covered long edge,
    // or a multiply-covered stretch leaves a macroscopic run, whereas the ≤0.2mm
    // sub-grid jitter of a genuine hairline stays inside the same quantization
    // slack the collinearity grouping already allows. (This deliberately still
    // admits the hosts whose exact-kernel meshing is itself not undirected-
    // watertight — the documented reason the hairline gate exists — while the
    // old midpoint test's spoof, a long edge grazed only near its midpoint by a
    // short reverse edge, leaves a run of nearly the whole edge and is rejected.)
    const GAP_TOL: f64 = COLLINEAR_TOL; // 2 grid units (~0.2 mm)
    for line in &lines {
        let mut ints: Vec<(f64, f64, i64)> = Vec::with_capacity(line.members.len());
        let mut breaks: Vec<f64> = Vec::with_capacity(line.members.len() * 2);
        for &si in &line.members {
            let s = &segs[si];
            let ta = dot(sub(s.a, line.o), line.dir);
            let tb = dot(sub(s.b, line.o), line.dir);
            let sign = if tb >= ta { 1 } else { -1 };
            ints.push((ta.min(tb), ta.max(tb), sign * s.m));
            breaks.push(ta);
            breaks.push(tb);
        }
        // `total_cmp`, matching the seed sort above: a non-finite coordinate here
        // must reject the cut, not abort the process.
        breaks.sort_by(|x, y| x.total_cmp(y));
        let mut run = 0.0_f64;
        for w in breaks.windows(2) {
            let (lo, hi) = (w[0], w[1]);
            let len = hi - lo;
            if len <= T_EPS {
                continue;
            }
            let mid = 0.5 * (lo + hi);
            let mut sum = 0i64;
            for &(ilo, ihi, sm) in &ints {
                if ilo - T_EPS <= mid && mid <= ihi + T_EPS {
                    sum += sm;
                }
            }
            if sum != 0 {
                run += len;
                if run > GAP_TOL {
                    return false;
                }
            } else {
                run = 0.0;
            }
        }
    }
    true
}
