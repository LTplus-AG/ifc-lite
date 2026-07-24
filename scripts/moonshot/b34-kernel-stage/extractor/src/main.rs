// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! B3.4 kernel-stage extractor.
//!
//! Input: a CSG corpus blob captured from the REAL pipeline by the existing
//! `csg_scaling_bench` example (`CSG_BENCH_DUMP=... cargo run --example
//! csg_scaling_bench --features csg-capture -- <model.ifc>`). Each job holds
//! the exact `Mesh` operands `mesh_bridge::subtract`/`subtract_many` received.
//!
//! This tool re-derives, per job, the exact triangle lists the arrangement
//! sees (mesh_to_tris snap -> cutter-vertex promotion -> outward orientation;
//! the two private pre-pass functions are copied VERBATIM from
//! `rust/geometry/src/kernel/mesh_bridge.rs` and validated end-to-end by
//! byte-comparing a full re-run of the boolean against the public
//! `mesh_bridge::subtract` output for every Single job), then enumerates the
//! broadphase candidate pairs exactly as `arrangement::arrange` does
//! (`broadphase::candidate_pairs`), applies the `near_coplanar` routing gate
//! (copied verbatim from `tritri.rs`), and emits the 6 all-Explicit orient3d
//! evaluations per surviving pair that `plane_interval` performs:
//!
//!     s_k = orient3d(other[0], other[1], other[2], tri[k])   (both directions)
//!
//! For every tuple it records the sign the PRODUCTION predicate path computes
//! (`kernel::predicates::orient3d` on Explicit points = Shewchuk adaptive via
//! the `geometry-predicates` crate), times the native stage (predicate-only
//! loop, best of N), and writes:
//!
//!   <out>.workload.bin  f64 LE, 12 per tuple (a,b,c,d as x,y,z each)
//!   <out>.signs.bin     i8 per tuple (-1/0/1), kernel-computed
//!   <out>.meta.json     per-job tuple counts (realized batch sizes),
//!                       near-coplanar routing stats, native timings,
//!                       FNV-1a sign manifest (same mix as kernel/manifest.rs)
//!
//! Usage: b34-extractor <corpus.bin> <out-prefix> [--fidelity]

use ifc_lite_geometry::csg_capture::{deserialize, CapturedCsgJob};
use ifc_lite_geometry::kernel::arrangement::Tri;
use ifc_lite_geometry::kernel::broadphase::candidate_pairs;
use ifc_lite_geometry::kernel::mesh_bridge::{mesh_to_tris, subtract};
use ifc_lite_geometry::kernel::predicates::orient3d;
use ifc_lite_geometry::kernel::{ImplicitPoint, Sign};
use std::fmt::Write as _;
use std::io::Write as _;
use std::time::Instant;

// ---------------------------------------------------------------------------
// VERBATIM COPIES of private mesh_bridge.rs / tritri.rs / signed_volume.rs
// helpers (they are `fn`/`pub(crate)` and unreachable from outside the crate).
// Copied 2026-07-24 from the worktree sources; the --fidelity mode proves the
// copies produce byte-identical booleans, so the stage inputs are the real ones.
// ---------------------------------------------------------------------------

const SNAP_GRID: f64 = 1.0 / 65536.0;

fn near_band_from_extent(extent: f64) -> f64 {
    (8.0 * SNAP_GRID).max(extent * (1.0 / 4_194_304.0))
}

fn signed_volume6(tris: &[Tri]) -> f64 {
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for t in tris {
        for v in t {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    if tris.is_empty() {
        return 0.0;
    }
    let o = [
        (lo[0] + hi[0]) * 0.5,
        (lo[1] + hi[1]) * 0.5,
        (lo[2] + hi[2]) * 0.5,
    ];
    tris.iter()
        .map(|t| {
            let a = [t[0][0] - o[0], t[0][1] - o[1], t[0][2] - o[2]];
            let b = [t[1][0] - o[0], t[1][1] - o[1], t[1][2] - o[2]];
            let c = [t[2][0] - o[0], t[2][1] - o[1], t[2][2] - o[2]];
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum()
}

fn orient_outward(mut tris: Vec<Tri>) -> Vec<Tri> {
    if signed_volume6(&tris) < 0.0 {
        for t in &mut tris {
            t.swap(1, 2);
        }
    }
    tris
}

fn exact_on_plane_weld(v: [f64; 3], t0: [f64; 3], t1: [f64; 3], t2: [f64; 3]) -> Option<[f64; 3]> {
    const Q: f64 = 1_048_576.0;
    const S16: f64 = 65_536.0;
    const S36: f64 = 68_719_476_736.0;
    let u = [t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]];
    let w = [t2[0] - t0[0], t2[1] - t0[1], t2[2] - t0[2]];
    let p = [v[0] - t0[0], v[1] - t0[1], v[2] - t0[2]];
    let dot = |a: &[f64; 3], b: &[f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (uu, ww, uw) = (dot(&u, &u), dot(&w, &w), dot(&u, &w));
    let (pu, pw) = (dot(&p, &u), dot(&p, &w));
    let det = uu * ww - uw * uw;
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let alpha = ((ww * pu - uw * pw) / det * Q).round();
    let beta = ((uu * pw - uw * pu) / det * Q).round();
    if !alpha.is_finite() || !beta.is_finite() || alpha.abs() > 8.0 * Q || beta.abs() > 8.0 * Q {
        return None;
    }
    let (ai, bi) = (alpha as i128, beta as i128);
    let mut out = [0.0f64; 3];
    for k in 0..3 {
        let (s0, s1, s2) = (t0[k] * S16, t1[k] * S16, t2[k] * S16);
        for s in [s0, s1, s2] {
            if s.fract() != 0.0 || s.abs() >= 9.0e18 {
                return None;
            }
        }
        let (i0, i1, i2) = (s0 as i128, s1 as i128, s2 as i128);
        let r36 = (i0 << 20) + ai * (i1 - i0) + bi * (i2 - i0);
        let rf = r36 as f64;
        if rf as i128 != r36 {
            return None;
        }
        out[k] = rf / S36;
    }
    Some(out)
}

fn promote_cutter_verts_onto_host_faces(cutter: &mut [Tri], host: &[Tri]) {
    if cutter.is_empty() || host.is_empty() {
        return;
    }
    let mut extent = 1.0f64;
    for t in cutter.iter().chain(host.iter()) {
        for v in t {
            for &x in v {
                extent = extent.max(x.abs());
            }
        }
    }
    let band = near_band_from_extent(extent);
    let band2 = band * band;

    struct Face {
        t0: [f64; 3],
        t1: [f64; 3],
        t2: [f64; 3],
        n: [f64; 3],
        nn: f64,
    }
    let faces: Vec<Face> = host
        .iter()
        .filter_map(|t| {
            let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
            let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            if nn <= 0.0 || !nn.is_finite() {
                return None;
            }
            Some(Face { t0: t[0], t1: t[1], t2: t[2], n, nn })
        })
        .collect();

    for t in cutter.iter_mut() {
        for v in t.iter_mut() {
            let mut best: Option<(f64, &Face)> = None;
            for f in &faces {
                let d = (v[0] - f.t0[0]) * f.n[0]
                    + (v[1] - f.t0[1]) * f.n[1]
                    + (v[2] - f.t0[2]) * f.n[2];
                if d == 0.0 {
                    continue;
                }
                let d2 = (d * d) / f.nn;
                if d2 > band2 {
                    continue;
                }
                if let Some((bd2, _)) = best {
                    if d2 >= bd2 {
                        continue;
                    }
                }
                best = Some((d2, f));
            }
            if let Some((_, f)) = best {
                if let Some(w) = exact_on_plane_weld(*v, f.t0, f.t1, f.t2) {
                    *v = w;
                }
            }
        }
    }
}

#[inline]
fn ti_sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn ti_cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn ti_dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn ti_normal(t: &[[f64; 3]; 3]) -> [f64; 3] {
    ti_cross(ti_sub(t[1], t[0]), ti_sub(t[2], t[0]))
}

fn near_coplanar(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> bool {
    let (n1, n2) = (ti_normal(t1), ti_normal(t2));
    let (nn1, nn2) = (ti_dot(n1, n1), ti_dot(n2, n2));
    if nn1 <= 0.0 || nn2 <= 0.0 || !nn1.is_finite() || !nn2.is_finite() {
        return false;
    }
    let mut extent = 1.0f64;
    for p in t1.iter().chain(t2.iter()) {
        for &c in p {
            extent = extent.max(c.abs());
        }
    }
    let band = near_band_from_extent(extent);
    let band2 = band * band;
    let in_slab = |t: &[[f64; 3]; 3], plane: &[[f64; 3]; 3], n: [f64; 3], nn: f64| {
        t.iter().all(|&v| {
            let d = ti_dot(ti_sub(v, plane[0]), n);
            (d * d) / nn <= band2
        })
    };
    in_slab(t2, t1, n1, nn1) || in_slab(t1, t2, n2, nn2)
}

// ---------------------------------------------------------------------------
// Stage extraction
// ---------------------------------------------------------------------------

/// The kernel's operand pre-pass for one job, exactly as `subtract` /
/// `subtract_many` perform it before `boolean` / `difference_all`.
fn job_operands(job: &CapturedCsgJob) -> (Vec<Tri>, Vec<Tri>) {
    match job {
        CapturedCsgJob::Single { host, cutter } => {
            let h = orient_outward(mesh_to_tris(host));
            let mut c = mesh_to_tris(cutter);
            promote_cutter_verts_onto_host_faces(&mut c, &h);
            let c = orient_outward(c);
            (h, c)
        }
        CapturedCsgJob::Many { host, cutters } => {
            // subtract_many orients each component individually, then
            // difference_all concatenates them into one operand list for the
            // single conforming arrangement.
            let h = orient_outward(mesh_to_tris(host));
            let mut all = Vec::new();
            for m in cutters {
                let mut c = mesh_to_tris(m);
                promote_cutter_verts_onto_host_faces(&mut c, &h);
                all.extend(orient_outward(c));
            }
            (h, all)
        }
    }
}

#[inline]
fn sign_i8(s: Sign) -> i8 {
    match s {
        Sign::Negative => -1,
        Sign::Zero => 0,
        Sign::Positive => 1,
    }
}

/// FNV-1a over sign codes, same scheme as kernel/manifest.rs::mix.
fn manifest_mix(h: &mut u64, s: i8) {
    let code: u8 = match s {
        -1 => 0,
        0 => 1,
        _ => 2,
    };
    *h ^= code as u64;
    *h = h.wrapping_mul(0x0000_0100_0000_01b3);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: b34-extractor <corpus.bin> <out-prefix> [--fidelity]");
        std::process::exit(2);
    }
    let corpus_path = &args[1];
    let out_prefix = &args[2];
    let fidelity = args.iter().any(|a| a == "--fidelity");

    let blob = std::fs::read(corpus_path).unwrap_or_else(|e| {
        eprintln!("skip: cannot read corpus {corpus_path}: {e}");
        std::process::exit(0);
    });
    let jobs = deserialize(&blob).expect("corpus blob deserializes");
    eprintln!("[extract] {} jobs from {corpus_path}", jobs.len());

    // --- fidelity gate: prove the copied pre-pass is byte-identical ---------
    // Re-run the FULL boolean with our re-derived operands and compare against
    // the public production `subtract` output, byte for byte, on every Single
    // job. (Many jobs share the same per-mesh pre-pass, validated through the
    // Single jobs; their difference_all path adds no operand mutation.)
    let mut fidelity_checked = 0usize;
    let mut fidelity_failed = 0usize;
    if fidelity {
        use ifc_lite_geometry::kernel::arrangement::{boolean, BoolOp};
        use ifc_lite_geometry::kernel::mesh_bridge::tris_to_mesh;
        for job in &jobs {
            if let CapturedCsgJob::Single { host, cutter } = job {
                let (h, c) = job_operands(job);
                let ours = tris_to_mesh(&boolean(&h, &c, BoolOp::Difference));
                let theirs = subtract(host, cutter);
                let same = ours.positions == theirs.positions
                    && ours.indices == theirs.indices;
                fidelity_checked += 1;
                if !same {
                    fidelity_failed += 1;
                }
            }
        }
        eprintln!(
            "[fidelity] {} single jobs re-run through the copied pre-pass + public boolean: {} byte-mismatches",
            fidelity_checked, fidelity_failed
        );
    }

    // --- stage extraction ---------------------------------------------------
    // Per candidate pair (i, j) surviving near_coplanar routing, the 6 tuples
    // plane_interval evaluates, in its exact call order:
    //   plane_interval(t1, plane=t2): orient3d(t2[0], t2[1], t2[2], t1[k]) k=0,1,2
    //   plane_interval(t2, plane=t1): orient3d(t1[0], t1[1], t1[2], t2[k]) k=0,1,2
    let mut workload: Vec<f64> = Vec::new(); // 12 per tuple
    let mut signs: Vec<i8> = Vec::new();
    let mut job_tuple_counts: Vec<usize> = Vec::new();
    let mut job_pair_counts: Vec<usize> = Vec::new();
    let mut job_host_tris: Vec<usize> = Vec::new();
    let mut job_cutter_tris: Vec<usize> = Vec::new();
    let mut near_coplanar_pairs = 0usize;
    let mut total_pairs = 0usize;

    let mut pair_lists: Vec<(Vec<Tri>, Vec<Tri>, Vec<(usize, usize)>)> = Vec::new();
    for job in &jobs {
        let (h, c) = job_operands(job);
        let pairs = candidate_pairs(&h, &c);
        pair_lists.push((h, c, pairs));
    }

    for (h, c, pairs) in &pair_lists {
        let mut tuples_this_job = 0usize;
        let mut pairs_this_job = 0usize;
        for &(i, j) in pairs {
            total_pairs += 1;
            let (t1, t2) = (&h[i], &c[j]);
            if near_coplanar(t1, t2) {
                near_coplanar_pairs += 1;
                continue;
            }
            pairs_this_job += 1;
            for k in 0..3 {
                workload.extend_from_slice(&t2[0]);
                workload.extend_from_slice(&t2[1]);
                workload.extend_from_slice(&t2[2]);
                workload.extend_from_slice(&t1[k]);
                tuples_this_job += 1;
            }
            for k in 0..3 {
                workload.extend_from_slice(&t1[0]);
                workload.extend_from_slice(&t1[1]);
                workload.extend_from_slice(&t1[2]);
                workload.extend_from_slice(&t2[k]);
                tuples_this_job += 1;
            }
        }
        job_tuple_counts.push(tuples_this_job);
        job_pair_counts.push(pairs_this_job);
        job_host_tris.push(h.len());
        job_cutter_tris.push(c.len());
    }

    let n_tuples = workload.len() / 12;
    eprintln!(
        "[extract] {} candidate pairs ({} routed near-coplanar) -> {} orient3d tuples",
        total_pairs, near_coplanar_pairs, n_tuples
    );

    // --- production-path signs + native stage timing ------------------------
    // The signs come from the REAL kernel dispatch (predicates::orient3d on
    // Explicit points = geometry_predicates Shewchuk adaptive). Timed as a
    // predicate-only loop over the extracted tuples, best of 5.
    let e = ImplicitPoint::Explicit;
    let mut best_ns = u128::MAX;
    for _ in 0..5 {
        signs.clear();
        signs.reserve(n_tuples);
        let t0 = Instant::now();
        for t in workload.chunks_exact(12) {
            let s = orient3d(
                &e([t[0], t[1], t[2]]),
                &e([t[3], t[4], t[5]]),
                &e([t[6], t[7], t[8]]),
                &e([t[9], t[10], t[11]]),
            );
            signs.push(sign_i8(s));
        }
        best_ns = best_ns.min(t0.elapsed().as_nanos());
    }
    let native_stage_ms = best_ns as f64 / 1e6;

    // Split timing: the exact-Zero tuples are the ones where the adaptive
    // filter cannot stop early (flush/grazing geometry) - how much of the
    // native stage do they cost vs the sign-definite majority?
    let zero_idx: Vec<usize> = (0..n_tuples).filter(|&i| signs[i] == 0).collect();
    let nonzero_idx: Vec<usize> = (0..n_tuples).filter(|&i| signs[i] != 0).collect();
    let time_subset = |idx: &[usize]| -> f64 {
        if idx.is_empty() {
            return 0.0;
        }
        let mut best = u128::MAX;
        for _ in 0..5 {
            let t0 = Instant::now();
            let mut acc = 0i64;
            for &i in idx {
                let t = &workload[i * 12..i * 12 + 12];
                let s = orient3d(
                    &e([t[0], t[1], t[2]]),
                    &e([t[3], t[4], t[5]]),
                    &e([t[6], t[7], t[8]]),
                    &e([t[9], t[10], t[11]]),
                );
                acc += sign_i8(s) as i64;
            }
            std::hint::black_box(acc);
            best = best.min(t0.elapsed().as_nanos());
        }
        best as f64 / 1e6
    };
    let native_zero_ms = time_subset(&zero_idx);
    let native_nonzero_ms = time_subset(&nonzero_idx);

    let mut manifest: u64 = 0xcbf2_9ce4_8422_2325;
    let (mut n_neg, mut n_zero, mut n_pos) = (0usize, 0usize, 0usize);
    for &s in &signs {
        manifest_mix(&mut manifest, s);
        match s {
            -1 => n_neg += 1,
            0 => n_zero += 1,
            _ => n_pos += 1,
        }
    }

    // --- outputs ------------------------------------------------------------
    {
        let mut buf: Vec<u8> = Vec::with_capacity(workload.len() * 8);
        for v in &workload {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(format!("{out_prefix}.workload.bin"), &buf).expect("write workload");
    }
    {
        let buf: Vec<u8> = signs.iter().map(|&s| s as u8).collect();
        std::fs::write(format!("{out_prefix}.signs.bin"), &buf).expect("write signs");
    }
    {
        // hand-rolled JSON (no serde dep): numbers and arrays only.
        let mut j = String::new();
        let _ = write!(
            j,
            "{{\n  \"corpus\": \"{corpus}\",\n  \"jobs\": {jobs},\n  \"totalPairs\": {tp},\n  \"nearCoplanarPairs\": {ncp},\n  \"tuples\": {nt},\n  \"signCounts\": {{ \"neg\": {nn}, \"zero\": {nz}, \"pos\": {np} }},\n  \"nativeStageMsBestOf5\": {ns},\n  \"nativeZeroSubsetMs\": {nzm},\n  \"nativeNonzeroSubsetMs\": {nnm},\n  \"signManifestFnv1a\": \"0x{mf:016x}\",\n  \"fidelityChecked\": {fc},\n  \"fidelityFailed\": {ff},\n  \"jobPairCounts\": {jpc:?},\n  \"jobTupleCounts\": {jtc:?},\n  \"jobHostTris\": {jht:?},\n  \"jobCutterTris\": {jct:?}\n}}\n",
            corpus = corpus_path,
            jobs = jobs.len(),
            tp = total_pairs,
            ncp = near_coplanar_pairs,
            nt = n_tuples,
            nn = n_neg,
            nz = n_zero,
            np = n_pos,
            ns = native_stage_ms,
            nzm = native_zero_ms,
            nnm = native_nonzero_ms,
            mf = manifest,
            fc = fidelity_checked,
            ff = fidelity_failed,
            jpc = job_pair_counts,
            jtc = job_tuple_counts,
            jht = job_host_tris,
            jct = job_cutter_tris,
        );
        std::fs::write(format!("{out_prefix}.meta.json"), j.as_bytes()).expect("write meta");
    }

    let mut out = std::io::stdout().lock();
    let _ = writeln!(
        out,
        "tuples={} pairs={} nearCoplanar={} nativeStageMs={:.3} manifest=0x{:016x} zeros={} fidelity={}/{}",
        n_tuples,
        total_pairs,
        near_coplanar_pairs,
        native_stage_ms,
        manifest,
        n_zero,
        fidelity_checked - fidelity_failed,
        fidelity_checked
    );
}
