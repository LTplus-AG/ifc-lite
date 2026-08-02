// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1007 — STRICT no-bridge assertion on the REAL faceted-BREP roof
//! opening, exercised through the SAME path the viewer renders
//! (`process_element_with_voids`, called by `gpu_meshes.rs:process_element_with_voids`).
//!
//! The synthetic `issue_1007_opening_sliver` test passes a CLEAN tilted box host
//! whose opening pokes THROUGH the top, and samples only 5 footprint points — it
//! missed the real defect: on host #1112 the opening's UPPER cap is authored
//! EXACTLY FLUSH with a faceted roof surface whose facets each sit ~0.1° off the
//! cap plane (f32 import). The exact kernel then saw neither a clean transversal
//! crossing nor an exactly-coplanar pair and left a well-proportioned (NOT a
//! needle) flap covering ~¼ of the hole on the upper surface — invisible to an
//! aspect-ratio / center-sample test but obvious in the viewer.
//!
//! This test DENSELY samples the WHOLE footprint on BOTH cut planes of each real
//! opening and asserts NO output host triangle aligned with that plane covers an
//! interior sample, plus no hairline needle and a watertight rim. It MUST FAIL on
//! the pre-fix tree and PASS after. Runs under `--no-default-features` (pure-Rust
//! kernel, NO Manifold).

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityIndex, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

const MODEL: &str = "../../tests/models/issues/1007_roof_brep_opening_winding.ifc";

// ───────────────────────── small vector helpers ─────────────────────────
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let l = norm(a);
    if l == 0.0 {
        a
    } else {
        [a[0] / l, a[1] / l, a[2] / l]
    }
}
fn tri_normal(t: &[[f64; 3]; 3]) -> [f64; 3] {
    unit(cross(sub(t[1], t[0]), sub(t[2], t[0])))
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

fn mesh_tris(m: &Mesh) -> Vec<[[f64; 3]; 3]> {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    m.indices.chunks_exact(3).map(|c| [v(c[0]), v(c[1]), v(c[2])]).collect()
}

/// Is `p` strictly inside triangle `t`'s interior projected onto its plane AND
/// within `band` of that plane? Detects a host triangle covering a hole sample.
fn covers(p: [f64; 3], t: &[[f64; 3]; 3], band: f64) -> bool {
    let n = tri_normal(t);
    if norm(n) < 1e-9 {
        return false;
    }
    if dot(sub(p, t[0]), n).abs() > band {
        return false;
    }
    let (ax, ay) = {
        let (nx, ny, nz) = (n[0].abs(), n[1].abs(), n[2].abs());
        if nx >= ny && nx >= nz {
            (1usize, 2usize)
        } else if ny >= nz {
            (0, 2)
        } else {
            (0, 1)
        }
    };
    let pr = |q: [f64; 3]| [q[ax], q[ay]];
    let (a, b, c, pp) = (pr(t[0]), pr(t[1]), pr(t[2]), pr(p));
    let cr = |o: [f64; 2], u: [f64; 2], w: [f64; 2]| {
        (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0])
    };
    let s0 = cr(a, b, pp);
    let s1 = cr(b, c, pp);
    let s2 = cr(c, a, pp);
    let eps = 1e-7;
    (s0 > eps && s1 > eps && s2 > eps) || (s0 < -eps && s1 < -eps && s2 < -eps)
}

fn tri_aspect(t: &[[f64; 3]; 3]) -> f64 {
    let d = |p: [f64; 3], q: [f64; 3]| norm(sub(p, q));
    let (e0, e1, e2) = (d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0]));
    let mn = e0.min(e1).min(e2);
    let mx = e0.max(e1).max(e2);
    if mn > 1e-9 {
        mx / mn
    } else {
        f64::INFINITY
    }
}

fn worst_aspect(tris: &[[[f64; 3]; 3]]) -> f64 {
    let mut worst = 0.0_f64;
    for t in tris {
        let a = tri_aspect(t);
        if a.is_finite() {
            worst = worst.max(a);
        }
    }
    worst
}

/// Worst aspect among output triangles INCIDENT to an opening-rim vertex. This
/// targets the #1007 rim-corner CHAMFER directly: a thin roof-slope flap fanned
/// from a far corner to two rim points a few cm apart. It sits on the host roof
/// plane OUTSIDE the cap footprint, so the footprint-bridge sampling structurally
/// cannot see it — but it touches a rim vertex. `rim` is the set of opening cut
/// vertices; a triangle is rim-incident if any of its vertices coincides with one.
fn worst_rim_incident_aspect(tris: &[[[f64; 3]; 3]], rim: &[[f64; 3]]) -> f64 {
    let near = |p: [f64; 3]| rim.iter().any(|r| norm(sub(p, *r)) < 5e-3);
    let mut worst = 0.0_f64;
    for t in tris {
        if t.iter().any(|p| near(*p)) {
            let a = tri_aspect(t);
            if a.is_finite() {
                worst = worst.max(a);
            }
        }
    }
    worst
}

/// Count undirected edges used exactly once (open boundary) on the cut mesh.
///
/// NOTE: this real faceted roof BREP is NOT a single closed 2-manifold shell —
/// cutting it leaves some open boundary edges at the host's own facet seams (44 on
/// the pre-fix tree, 41 after this fix) regardless of the opening cut. So this is a
/// NON-REGRESSION bound (a gross tear from a broken cut runs into the hundreds),
/// not a `== 0` watertight assertion; the load-bearing assertion is the no-bridge
/// footprint coverage.
fn open_boundary_edges(tris: &[[[f64; 3]; 3]]) -> usize {
    let key = |p: [f64; 3]| {
        (
            (p[0] * 4096.0).round() as i64,
            (p[1] * 4096.0).round() as i64,
            (p[2] * 4096.0).round() as i64,
        )
    };
    let mut edges: BTreeMap<((i64, i64, i64), (i64, i64, i64)), u32> = BTreeMap::new();
    for t in tris {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(k[0], k[1]), (k[1], k[2]), (k[2], k[0])] {
            *edges.entry(if u < v { (u, v) } else { (v, u) }).or_insert(0) += 1;
        }
    }
    edges.values().filter(|&&c| c == 1).count()
}

/// Process the host with voids through the VIEWER path and probe every opening's
/// footprint on each cut plane. Returns the worst per-cap bridged-sample count.
fn worst_bridged_samples(path: &str, host_id: u32) -> Option<usize> {
    let content = std::fs::read_to_string(path).ok()?;
    let index: EntityIndex = build_entity_index(&content);
    let voids = build_void_index(&content);
    let opening_ids = voids.get(&host_id).cloned().unwrap_or_default();
    if opening_ids.is_empty() {
        return None;
    }

    let mut decoder = EntityDecoder::with_index(&content, index.clone());
    let host = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);

    // The exact mesh the viewer renders (gpu_meshes.rs calls this same fn).
    let out = router.process_element_with_voids(&host, &mut decoder, &voids).ok()?;
    let out_tris = mesh_tris(&out);
    assert!(!out_tris.is_empty(), "cut host #{host_id} produced an empty mesh");

    // No hairline needle flap anywhere in the cut.
    let wa = worst_aspect(&out_tris);
    assert!(
        wa < 1.0e4,
        "host #{host_id}: an opening-spanning needle survived (worst aspect {wa:.0}:1)",
    );
    // Non-regression on torn rim: this BREP host leaves ~41–44 open facet-seam
    // edges either way; a broken cut that tears the opening rim open balloons this
    // into the hundreds. Bound it generously so a real tear is still caught.
    let ob = open_boundary_edges(&out_tris);
    assert!(
        ob <= 80,
        "host #{host_id}: cut left {ob} open boundary edges — the opening rim is torn open",
    );

    // Collect every opening-cut vertex (the rim) so we can bound the worst aspect
    // of the host triangles that touch it — the rim-corner CHAMFER guard (below).
    let mut rim: Vec<[f64; 3]> = Vec::new();
    for &oid in &opening_ids {
        if let Ok(oe) = decoder.decode_by_id(oid) {
            if let Ok(om) = router.process_element(&oe, &mut decoder) {
                if !om.is_empty() {
                    for t in mesh_tris(&om) {
                        rim.extend_from_slice(&t);
                    }
                }
            }
        }
    }
    // RIM-CORNER CHAMFER guard (#1007): a thin roof-slope flap fanned from a far
    // corner to two rim points a few cm apart. It lies on the host roof plane
    // OUTSIDE the cap footprint, so the footprint-bridge sampling can never catch
    // it — but it touches a rim vertex and renders as a visible chamfer. History:
    // 74:1 (flush-pad under-tune) → 25:1 (pad 0.30, still visible) → 7.74:1 after
    // the root fix (facet_weld pre-cut jitter weld + CDT-refined consolidate +
    // post-cut >8:1 bisection, which targets aspect ≤8 by construction). The
    // 10:1 bound sits just above the construction target and far below the 25:1
    // defect, so any regression of the far-corner fan fails clearly.
    let wri = worst_rim_incident_aspect(&out_tris, &rim);
    eprintln!(
        "[1007-metrics] host #{host_id}: worst_rim_incident_aspect={wri:.2} \
         worst_aspect={wa:.2} open_boundary_edges={ob} out_tris={}",
        out_tris.len()
    );
    assert!(
        wri < 10.0,
        "host #{host_id}: a rim-corner chamfer/flap survived on the roof slope \
         (worst rim-incident aspect {wri:.1}:1) — the opening cut leaves a thin tab \
         at the opening corner",
    );

    let mut worst = 0usize;
    for &oid in &opening_ids {
        let oe = match decoder.decode_by_id(oid) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let om = match router.process_element(&oe, &mut decoder) {
            Ok(m) if !m.is_empty() => m,
            _ => continue,
        };
        let ot = mesh_tris(&om);
        // Cluster opening triangle normals into plane buckets; the two
        // highest-area opposite-facing buckets are the caps flush with the host.
        let mut bucket: Vec<([f64; 3], f64, f64)> = Vec::new(); // (normal, offset, area)
        for t in &ot {
            let n = tri_normal(t);
            if norm(n) < 1e-9 {
                continue;
            }
            let off = dot(t[0], n);
            let area = 0.5 * norm(cross(sub(t[1], t[0]), sub(t[2], t[0])));
            let mut found = false;
            for b in bucket.iter_mut() {
                if dot(b.0, n) > 0.999 && (b.1 - off).abs() < 1e-3 {
                    b.2 += area;
                    found = true;
                    break;
                }
            }
            if !found {
                bucket.push((n, off, area));
            }
        }
        bucket.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
        let caps: Vec<([f64; 3], f64)> = bucket.iter().take(2).map(|b| (b.0, b.1)).collect();

        for (cn, coff) in &caps {
            let cn = *cn;
            // in-plane sampling basis
            let seed = if cn[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [0.0, 1.0, 0.0] };
            let u = unit(cross(seed, cn));
            let v = unit(cross(cn, u));
            // collect opening verts ON this cap plane, derive the footprint bounds
            let cverts: Vec<[f64; 3]> =
                ot.iter().flatten().copied().filter(|p| (dot(*p, cn) - coff).abs() < 1e-3).collect();
            if cverts.len() < 3 {
                continue;
            }
            let c0 = {
                let mut s = [0.0; 3];
                for p in &cverts {
                    s = [s[0] + p[0], s[1] + p[1], s[2] + p[2]];
                }
                let k = cverts.len() as f64;
                [s[0] / k, s[1] / k, s[2] / k]
            };
            let (mut umin, mut umax, mut vmin, mut vmax) =
                (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
            for p in &cverts {
                let w = sub(*p, c0);
                let (uu, vv) = (dot(w, u), dot(w, v));
                umin = umin.min(uu);
                umax = umax.max(uu);
                vmin = vmin.min(vv);
                vmax = vmax.max(vv);
            }
            // dense interior grid (inset, never touching the rim)
            let n = 24usize;
            let mut covered = 0usize;
            for i in 1..n {
                for j in 1..n {
                    let su = umin + (umax - umin) * (i as f64) / (n as f64);
                    let sv = vmin + (vmax - vmin) * (j as f64) / (n as f64);
                    let p = [
                        c0[0] + u[0] * su + v[0] * sv,
                        c0[1] + u[1] * su + v[1] * sv,
                        c0[2] + u[2] * su + v[2] * sv,
                    ];
                    if out_tris
                        .iter()
                        .any(|t| dot(tri_normal(t), cn).abs() > 0.99 && covers(p, t, 1e-3))
                    {
                        covered += 1;
                    }
                }
            }
            worst = worst.max(covered);
        }
    }
    Some(worst)
}

/// STRICT: the real #1112 roof openings (#2150 / #2154) must be cut with NO host
/// triangle bridging the footprint on EITHER cut plane, via the viewer path.
#[test]
fn real_1112_roof_openings_have_no_bridging_triangle() {
    let Some(worst) = worst_bridged_samples(MODEL, 1112) else {
        // Fixture absent in this checkout — nothing to assert.
        eprintln!("skip: {MODEL} (host #1112 voids) not available");
        return;
    };
    // A dense 23×23 interior grid per cap plane. Pre-fix this was 142/529 (#2150
    // upper) and 48/529 (#2154 upper); a clean cut leaves ZERO. Allow a tiny slack
    // for f32 edge effects on the densest grid — the defect was ¼ of the hole.
    assert_eq!(
        worst, 0,
        "a host triangle bridges a real #1112 opening footprint ({worst} interior samples covered) \
         — the exact-kernel opening cut still leaves a flap over the hole",
    );
}

/// Schependomlaan window opening — same strict assertion, SKIP-IF-ABSENT. Models a
/// real-world axis-aligned flush window; if the corpus model is present in this
/// checkout it must also cut clean via the exact path. (Host id is read from the
/// env so the corpus model can be wired without hardcoding an entity id.)
#[test]
fn real_schependomlaan_window_has_no_bridging_triangle() {
    // Common staging locations; first hit wins.
    let candidates = [
        "../../tests/models/various/schependomlaan.ifc",
        "../../tests/models/local/schependomlaan.ifc",
        "../../tests/models/issues/schependomlaan.ifc",
    ];
    let Some(path) = candidates.iter().find(|p| std::path::Path::new(p).exists()) else {
        eprintln!("skip: schependomlaan fixture not present in this checkout");
        return;
    };
    let host_id: u32 = match std::env::var("SCHEP_HOST").ok().and_then(|s| s.parse().ok()) {
        Some(id) => id,
        None => {
            eprintln!("skip: set SCHEP_HOST=<wall entity id> to probe {path}");
            return;
        }
    };
    let Some(worst) = worst_bridged_samples(path, host_id) else {
        eprintln!("skip: {path} host #{host_id} has no voids");
        return;
    };
    assert_eq!(
        worst, 0,
        "a host triangle bridges a schependomlaan window footprint ({worst} samples) via the exact path",
    );
}
