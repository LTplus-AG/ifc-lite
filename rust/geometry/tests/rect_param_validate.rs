// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! NOTE: `#[ignore]` + needs an external corpus model, so it does NOT gate in
//! CI. The hermetic CI gate on the shipped default is `rect_param_gate.rs`
//! (inline fixture, no fetch).
//!
//! Corpus A/B validation for the PARAMETRIC rect-opening fast path
//! (`IFC_LITE_RECT_PARAM` / `rect_fast::param_enabled`), modeled on
//! `dedup_validate.rs`: drive the PRODUCTION submesh path
//! (`produce_element_meshes` entry points) over every geometry job in a real
//! model with the flag ON and OFF, and assert:
//!
//!   1. Every element where the fast path did NOT fire is BYTE-IDENTICAL
//!      between ON and OFF (fingerprint over positions/normals/indices/origin).
//!   2. Every element where it DID fire is watertight and matches the ANALYTIC
//!      box-minus-boxes ground truth by volume within 5% (the same oracle
//!      `rect_param_parity.rs` / `rect_param_production.rs` assert against --
//!      the exact kernel is an imperfect oracle with documented 9-34% over-cut
//!      on engulfing-opening walls, so fired hosts are NOT expected to be
//!      byte-equal to the kernel; the param volume may EXCEED the kernel's).
//!
//! Timing: the ON/OFF passes are interleaved ABAB (OFF, ON, OFF, ON, ...) so
//! background machine load cannot bias one side; raw runs and per-side medians
//! are printed, plus the voided-host-only (CSG) share of each run.
//!
//! Run (server-release: the release profile is panic=abort, which test
//! binaries cannot link; server-release re-enables unwinding):
//!   IFCLT_MODEL=/abs/path.ifc cargo test -p ifc-lite-geometry \
//!     --profile server-release --test rect_param_validate -- --ignored --nocapture
//! Optional: RECT_PARAM_TIMING_PAIRS=N   (ABAB pairs, default 3)

use ifc_lite_core::{build_entity_index, has_geometry_by_name, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::rect_fast::{param_set_enabled_override, take_param_fires};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh, RectParam, SubMeshCollection};
use nalgebra::Matrix3;
use rustc_hash::{FxHashMap, FxHasher};
use std::hash::{Hash, Hasher};
use std::time::Instant;

/// Fired cuts must match the analytic ground truth within this relative volume
/// tolerance (the `rect_param_production.rs` bar).
const ANALYTIC_VOL_TOL: f64 = 0.05;
/// Informational band for param-vs-kernel volume: the kernel over-cuts up to
/// ~34% on engulfing openings, so param_vol/kernel_vol in [0.95, 1.50] is the
/// documented expectation. Out-of-band hosts are listed (they are only a
/// FAILURE if they also miss the analytic oracle).
const KERNEL_BAND: (f64, f64) = (0.95, 1.50);

fn build_void_index(content: &str, decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut scan_decoder = EntityDecoder::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = scan_decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    idx.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut idx, content, decoder);
    idx
}

/// Content fingerprint of a placed sub-mesh collection -- every bit the
/// renderer consumes (geometry id, f32 positions/normals, indices, and the
/// f64 local-frame origin), in submesh order; field coverage mirrors
/// dedup_validate.rs. Hashed with the seed-free `FxHasher` so runs on the
/// same toolchain produce stable values (`DefaultHasher` guarantees nothing
/// across processes); the pass/fail comparison is ON-vs-OFF within one run.
fn fingerprint(sm: &SubMeshCollection) -> u64 {
    let mut h = FxHasher::default();
    sm.sub_meshes.len().hash(&mut h);
    for s in &sm.sub_meshes {
        s.geometry_id.hash(&mut h);
        s.mesh.positions.len().hash(&mut h);
        for &p in &s.mesh.positions {
            p.to_bits().hash(&mut h);
        }
        for &n in &s.mesh.normals {
            n.to_bits().hash(&mut h);
        }
        for &i in &s.mesh.indices {
            i.hash(&mut h);
        }
        for &o in &s.mesh.origin {
            o.to_bits().hash(&mut h);
        }
    }
    h.finish()
}

fn mesh_volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let v = |i: u32| {
                let b = i as usize * 3;
                [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
            };
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

/// Quantized undirected-edge watertightness (the rect_param_production.rs
/// checker): every non-degenerate edge must be shared by exactly 2 triangles.
fn watertight(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (q(mesh.positions[b]), q(mesh.positions[b + 1]), q(mesh.positions[b + 2]))
    };
    let mut edges: FxHashMap<((i64, i64, i64), (i64, i64, i64)), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            let e = if x < y { (x, y) } else { (y, x) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 2)
}

/// Signed-permutation axis map of `m` (each row one entry ~ +-1), or `None`.
fn signed_perm(m: &Matrix3<f64>, tol: f64) -> Option<[usize; 3]> {
    let mut out = [0usize; 3];
    let mut used = [false; 3];
    for i in 0..3 {
        let (mut best, mut ba, mut second) = (0usize, 0.0, 0.0);
        for j in 0..3 {
            let a = m[(i, j)].abs();
            if a > ba {
                second = ba;
                ba = a;
                best = j;
            } else if a > second {
                second = a;
            }
        }
        if ba < 1.0 - tol || second > tol || used[best] {
            return None;
        }
        used[best] = true;
        out[i] = best;
    }
    Some(out)
}

/// Analytic GROUND-TRUTH cut volume for a box host: host box minus the union of
/// opening boxes clamped to the host (the fire gate guarantees non-overlap, so
/// the union is the simple sum). Exact for box-minus-boxes. Copied from
/// rect_param_production.rs.
fn analytic_cut_volume(
    router: &GeometryRouter,
    host: &DecodedEntity,
    opening_ids: &[u32],
    decoder: &mut EntityDecoder,
) -> Option<f64> {
    let hp: RectParam = router.parametric_rect_probe(host, decoder)?;
    let rt = hp.r.transpose();
    let host_vol = 8.0 * hp.half[0] * hp.half[1] * hp.half[2];
    let mut opening_vol = 0.0;
    for &oid in opening_ids {
        let opening = decoder.decode_by_id(oid).ok()?;
        if opening.ifc_type != IfcType::IfcOpeningElement {
            continue;
        }
        let boxes = router.parametric_rect_probe_all(&opening, decoder)?;
        for b in boxes {
            let map = signed_perm(&(rt * b.r), 1.0e-3)?;
            let cf = rt * (b.center - hp.center);
            let cf = [cf.x, cf.y, cf.z];
            let half_f = [b.half[map[0]], b.half[map[1]], b.half[map[2]]];
            let mut v = 1.0;
            for i in 0..3 {
                let lo = (cf[i] - half_f[i]).max(-hp.half[i]);
                let hi = (cf[i] + half_f[i]).min(hp.half[i]);
                v *= (hi - lo).max(0.0);
            }
            opening_vol += v;
        }
    }
    Some((host_vol - opening_vol).abs())
}

/// One full pass over every geometry job through the PRODUCTION submesh path
/// with the param flag forced to `on`. Returns per-element (id, fingerprint,
/// fires), total triangles, loop wall-time (ms), and the voided-host-only share
/// of that wall-time (ms). Fresh decoder + cold router per call so ON and OFF
/// are a fair cold-cache comparison.
fn run_pass(
    content: &str,
    all_jobs: &[u32],
    void_idx: &FxHashMap<u32, Vec<u32>>,
    on: bool,
) -> (Vec<(u32, u64, u64)>, usize, f64, f64) {
    // Sentinels keep ON and OFF 1:1 aligned even on decode/mesh errors.
    const FP_DECODE_ERR: u64 = u64::MAX;
    const FP_MESH_ERR: u64 = u64::MAX - 1;

    param_set_enabled_override(Some(on));
    let _ = take_param_fires();

    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let router = GeometryRouter::with_units(content, &mut decoder);
    let mut fps: Vec<(u32, u64, u64)> = Vec::with_capacity(all_jobs.len());
    let mut tris = 0usize;
    let mut voids_ms = 0.0f64;
    let t = Instant::now();
    for id in all_jobs {
        let entity = match decoder.decode_by_id(*id) {
            Ok(e) => e,
            Err(_) => {
                fps.push((*id, FP_DECODE_ERR, 0));
                continue;
            }
        };
        let openings = void_idx.get(id).map(|v| v.len()).unwrap_or(0);
        let te = Instant::now();
        let sm = if openings > 0 {
            router.process_element_with_submeshes_and_voids(&entity, &mut decoder, void_idx)
        } else {
            router.process_element_with_submeshes(&entity, &mut decoder)
        };
        if openings > 0 {
            voids_ms += te.elapsed().as_secs_f64() * 1000.0;
        }
        let fires = take_param_fires();
        match sm {
            Ok(sm) => {
                tris += sm.sub_meshes.iter().map(|s| s.mesh.indices.len() / 3).sum::<usize>();
                fps.push((*id, fingerprint(&sm), fires));
            }
            Err(_) => fps.push((*id, FP_MESH_ERR, fires)),
        }
    }
    let total_ms = t.elapsed().as_secs_f64() * 1000.0;
    param_set_enabled_override(None);
    (fps, tris, total_ms, voids_ms)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

#[test]
#[ignore = "manual corpus A/B; needs IFCLT_MODEL"]
fn rect_param_ab_validate() {
    let path = match std::env::var("IFCLT_MODEL") {
        Ok(p) => p,
        Err(_) => {
            println!("set IFCLT_MODEL=/abs/path.ifc");
            return;
        }
    };
    let pairs: usize = std::env::var("RECT_PARAM_TIMING_PAIRS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(3);
    let content = std::fs::read_to_string(&path).expect("read model");
    println!("\n=== rect-param A/B (production submesh path) ===");
    println!("model: {path}  ({} bytes)", content.len());

    let mut idx_decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let void_idx = build_void_index(&content, &mut idx_decoder);
    let mut all_jobs: Vec<u32> = Vec::new();
    {
        let mut scanner = EntityScanner::new(&content);
        while let Some((id, name, _, _)) = scanner.next_entity() {
            if has_geometry_by_name(name) {
                all_jobs.push(id);
            }
        }
    }
    println!("geometry jobs: {}  voided hosts: {}", all_jobs.len(), void_idx.len());

    // --- ABAB interleaved passes: OFF, ON, OFF, ON, ... -------------------
    let mut off_runs: Vec<(Vec<(u32, u64, u64)>, usize, f64, f64)> = Vec::new();
    let mut on_runs: Vec<(Vec<(u32, u64, u64)>, usize, f64, f64)> = Vec::new();
    for p in 0..pairs {
        let off = run_pass(&content, &all_jobs, &void_idx, false);
        let on = run_pass(&content, &all_jobs, &void_idx, true);
        println!(
            "  pair {p}: OFF {:>7.0}ms (voids {:>6.0}ms)   ON {:>7.0}ms (voids {:>6.0}ms)",
            off.2, off.3, on.2, on.3
        );
        off_runs.push(off);
        on_runs.push(on);
    }
    let (off_fps, off_tris, ..) = &off_runs[0];
    let (on_fps, on_tris, ..) = &on_runs[0];

    // Fired set must be identical across ON runs (determinism of the gate).
    let fired_total: u64 = on_fps.iter().map(|e| e.2).sum();
    for (i, r) in on_runs.iter().enumerate().skip(1) {
        let f: u64 = r.0.iter().map(|e| e.2).sum();
        assert_eq!(f, fired_total, "ON run {i} fired a different number of cuts");
    }
    // The OFF side must never fire.
    let off_fires: u64 = off_runs.iter().flat_map(|r| r.0.iter().map(|e| e.2)).sum();
    assert_eq!(off_fires, 0, "param path fired while forced OFF");

    // --- 1. Non-fired elements: byte-identical ON vs OFF ------------------
    assert_eq!(off_fps.len(), on_fps.len(), "element count diverged ON vs OFF");
    let mut fired_ids: Vec<u32> = Vec::new();
    let mut nonfired_identical = 0usize;
    let mut nonfired_diverged: Vec<u32> = Vec::new();
    for ((off_id, off_fp, _), (on_id, on_fp, on_fires)) in off_fps.iter().zip(on_fps.iter()) {
        assert_eq!(off_id, on_id, "element order diverged");
        if *on_fires > 0 {
            fired_ids.push(*on_id);
        } else if off_fp == on_fp {
            nonfired_identical += 1;
        } else {
            nonfired_diverged.push(*on_id);
        }
    }

    // --- 2. Fired hosts: watertight + analytic-oracle volume --------------
    // Re-run each fired host through the merged-mesh production entry
    // (`process_element_with_voids`) ON and OFF for the geometric checks; the
    // volume comparison needs one mesh per element.
    let mut wt_ok = 0usize;
    let mut wt_bad: Vec<u32> = Vec::new();
    let mut vol_ok = 0usize;
    let mut vol_bad: Vec<(u32, f64, f64)> = Vec::new(); // (id, param_vol, truth)
    let mut no_oracle: Vec<u32> = Vec::new();
    let mut kernel_hist = [0usize; 6]; // <0.5%, 0.5-2%, 2-5%, 5-20%, 20-40%, >40%
    let mut kernel_out_of_band: Vec<(u32, f64)> = Vec::new(); // (id, param/kernel)
    {
        let mut d = EntityDecoder::with_index(&content, build_entity_index(&content));
        let router = GeometryRouter::with_units(&content, &mut d);
        for &id in &fired_ids {
            let Ok(host) = d.decode_by_id(id) else { continue };

            param_set_enabled_override(Some(true));
            let _ = take_param_fires();
            let param_mesh = router.process_element_with_voids(&host, &mut d, &void_idx);
            let merged_fired = take_param_fires() > 0;
            param_set_enabled_override(Some(false));
            let kernel_mesh = router.process_element_with_voids(&host, &mut d, &void_idx);
            param_set_enabled_override(None);

            let (Ok(pm), Ok(km)) = (param_mesh, kernel_mesh) else { continue };
            if !merged_fired {
                // Fired on the submesh path but deferred on the merged path
                // (different mesh entry) -- the merged output IS the kernel
                // output, nothing param-specific to judge here.
                wt_ok += 1;
                vol_ok += 1;
                continue;
            }
            if watertight(&pm) {
                wt_ok += 1;
            } else {
                wt_bad.push(id);
            }
            let pv = mesh_volume(&pm).abs();
            let kv = mesh_volume(&km).abs();
            match analytic_cut_volume(&router, &host, &void_idx[&id], &mut d) {
                Some(truth) if truth > 1.0e-9 => {
                    let rel = (pv - truth).abs() / truth;
                    if rel <= ANALYTIC_VOL_TOL {
                        vol_ok += 1;
                    } else {
                        vol_bad.push((id, pv, truth));
                    }
                }
                _ => no_oracle.push(id),
            }
            let ratio = if kv > 1.0e-9 { pv / kv } else { f64::INFINITY };
            let rel_k = (ratio - 1.0).abs();
            kernel_hist[if rel_k < 0.005 { 0 } else if rel_k < 0.02 { 1 } else if rel_k < 0.05 { 2 }
                else if rel_k < 0.20 { 3 } else if rel_k < 0.40 { 4 } else { 5 }] += 1;
            if ratio < KERNEL_BAND.0 || ratio > KERNEL_BAND.1 {
                kernel_out_of_band.push((id, ratio));
            }
        }
    }

    // --- summary -----------------------------------------------------------
    println!("\n--- per-model summary ---");
    println!("hosts total (voided)        : {}", void_idx.len());
    println!("elements fired (submesh run): {}   (total fires {fired_total})", fired_ids.len());
    println!(
        "non-fired byte-identical    : {nonfired_identical} / {}   (diverged: {})",
        nonfired_identical + nonfired_diverged.len(),
        nonfired_diverged.len()
    );
    println!("fired watertight            : {wt_ok} / {}   (bad: {})", fired_ids.len(), wt_bad.len());
    println!(
        "fired analytic-volume ok    : {vol_ok} / {}   (bad: {}, no-oracle: {})",
        fired_ids.len(),
        vol_bad.len(),
        no_oracle.len()
    );
    println!("param-vs-kernel |vol delta| histogram (fired, merged path):");
    for (l, c) in ["<0.5%", "0.5-2%", "2-5%", "5-20%", "20-40%", ">40%"].iter().zip(kernel_hist.iter()) {
        println!("  {l:>7} : {c}");
    }
    if !kernel_out_of_band.is_empty() {
        println!("param/kernel volume ratio OUT of [{}, {}] band (informational):", KERNEL_BAND.0, KERNEL_BAND.1);
        for (id, r) in kernel_out_of_band.iter().take(20) {
            println!("  host #{id}: ratio {r:.3}");
        }
    }
    if !nonfired_diverged.is_empty() {
        println!("FINDING non-fired divergent ids: {:?}", &nonfired_diverged[..nonfired_diverged.len().min(20)]);
    }
    if !wt_bad.is_empty() {
        println!("FINDING non-watertight fired ids: {:?}", &wt_bad[..wt_bad.len().min(20)]);
    }
    for (id, pv, truth) in vol_bad.iter().take(20) {
        println!("FINDING analytic-volume miss host #{id}: param_vol={pv:.4} truth={truth:.4}");
    }
    if !no_oracle.is_empty() {
        println!("no-oracle fired ids (probe failed post-hoc): {:?}", &no_oracle[..no_oracle.len().min(20)]);
    }

    let off_times: Vec<f64> = off_runs.iter().map(|r| r.2).collect();
    let on_times: Vec<f64> = on_runs.iter().map(|r| r.2).collect();
    let off_voids: Vec<f64> = off_runs.iter().map(|r| r.3).collect();
    let on_voids: Vec<f64> = on_runs.iter().map(|r| r.3).collect();
    let (om, nm) = (median(off_times.clone()), median(on_times.clone()));
    let (ovm, nvm) = (median(off_voids.clone()), median(on_voids.clone()));
    println!("\n--- timing (ABAB interleaved, {pairs} pairs) ---");
    println!("raw OFF total ms: {:?}", off_times.iter().map(|v| *v as u64).collect::<Vec<_>>());
    println!("raw ON  total ms: {:?}", on_times.iter().map(|v| *v as u64).collect::<Vec<_>>());
    println!("median total : OFF {om:.0}ms  ON {nm:.0}ms  delta {:+.1}%", (nm - om) / om * 100.0);
    println!("raw OFF voids ms: {:?}", off_voids.iter().map(|v| *v as u64).collect::<Vec<_>>());
    println!("raw ON  voids ms: {:?}", on_voids.iter().map(|v| *v as u64).collect::<Vec<_>>());
    println!(
        "median voided-hosts only: OFF {ovm:.0}ms  ON {nvm:.0}ms  delta {:+.1}%",
        if ovm > 0.0 { (nvm - ovm) / ovm * 100.0 } else { 0.0 }
    );
    println!("triangles: OFF {off_tris}  ON {on_tris}");

    // --- assertions ---------------------------------------------------------
    assert!(
        nonfired_diverged.is_empty(),
        "{} non-fired elements diverged ON vs OFF: {:?}",
        nonfired_diverged.len(),
        &nonfired_diverged[..nonfired_diverged.len().min(20)]
    );
    assert!(
        wt_bad.is_empty(),
        "{} fired hosts are not watertight: {:?}",
        wt_bad.len(),
        &wt_bad[..wt_bad.len().min(20)]
    );
    assert!(
        vol_bad.is_empty(),
        "{} fired hosts miss the analytic ground truth by >{ANALYTIC_VOL_TOL:.0e}: {:?}",
        vol_bad.len(),
        vol_bad.iter().map(|v| v.0).take(20).collect::<Vec<_>>()
    );
    println!("\nOK rect-param A/B clean on {path}");
}
