// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PRODUCTION wiring test: with the parametric fast path forced ON, the real
//! `process_element_with_voids` pipeline must (a) actually FIRE the analytic cut on
//! rotated rectangular walls, and (b) every fired host's output must be watertight.
//! Correctness vs ground truth is proven separately in `rect_param_parity`; this proves
//! the end-to-end wiring + the production safety invariant.
//!
//! NOTE: `#[ignore]` + needs an external corpus model, so it does NOT gate in
//! CI. The hermetic CI gate on the shipped default is `rect_param_gate.rs`
//! (inline fixture, no fetch).
//!
//! Run: MEASURE_FIXTURE=<path> cargo test --test rect_param_production -- --ignored --nocapture

use ifc_lite_core::{build_entity_index, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh, RectParam};
use nalgebra::Matrix3;
use rustc_hash::FxHashMap;

/// Signed-permutation axis map of `m` (each row one entry ≈±1), or `None`.
fn signed_perm(m: &Matrix3<f64>, tol: f64) -> Option<[usize; 3]> {
    let mut out = [0usize; 3];
    let mut used = [false; 3];
    for i in 0..3 {
        let (mut best, mut ba, mut second) = (0usize, 0.0, 0.0);
        for j in 0..3 {
            let a = m[(i, j)].abs();
            if a > ba { second = ba; ba = a; best = j; } else if a > second { second = a; }
        }
        if ba < 1.0 - tol || second > tol || used[best] { return None; }
        used[best] = true;
        out[i] = best;
    }
    Some(out)
}

/// Analytic GROUND-TRUTH cut volume for a box host: host-box minus the union of opening
/// boxes clamped to the host (openings are non-overlapping by the fire gate, so the union
/// is the simple sum). Exact for box-minus-boxes; `None` if the host isn't a clean box.
fn analytic_cut_volume(
    router: &GeometryRouter,
    host: &DecodedEntity,
    opening_ids: &[u32],
    decoder: &mut EntityDecoder,
) -> Option<(f64, usize)> {
    let hp: RectParam = router.parametric_rect_probe(host, decoder)?;
    let rt = hp.r.transpose();
    let host_vol = 8.0 * hp.half[0] * hp.half[1] * hp.half[2];
    let mut opening_vol = 0.0;
    let mut nb = 0usize;
    for &oid in opening_ids {
        let opening = decoder.decode_by_id(oid).ok()?;
        if opening.ifc_type != IfcType::IfcOpeningElement {
            continue;
        }
        let boxes = router.parametric_rect_probe_all(&opening, decoder)?;
        nb += boxes.len();
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
    Some(((host_vol - opening_vol).abs(), nb))
}

const DEFAULT_FIXTURE: &str = "../../tests/models/buildingsmart/wall-with-opening-and-window.ifc";

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

fn watertight(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
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

fn build_void_index(content: &str, decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut scan_decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = scan_decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, decoder);
    void_index
}

#[test]
#[ignore = "production wiring test -- run explicitly with MEASURE_FIXTURE"]
fn param_fast_path_fires_in_production_and_is_watertight() {
    let fixture = std::env::var("MEASURE_FIXTURE").unwrap_or_else(|_| DEFAULT_FIXTURE.to_string());
    if !std::path::Path::new(&fixture).exists() {
        eprintln!("skipping: fixture {fixture} not present");
        return;
    }
    let content = std::fs::read_to_string(&fixture).expect("read fixture");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_index = build_void_index(&content, &mut decoder);

    let mut host_ids: Vec<u32> = void_index.keys().copied().collect();
    host_ids.sort_unstable();

    // Force the parametric fast path ON for the production pipeline.
    ifc_lite_geometry::rect_fast::param_set_enabled_override(Some(true));
    let _ = ifc_lite_geometry::rect_fast::take_param_fires();

    let mut fired_hosts = 0usize;
    let mut wt_bad = 0usize;
    let mut total_fires = 0u64;
    let mut hist = [0usize; 5]; // param-vs-exact rel-delta: <0.5%, 0.5-2%, 2-5%, 5-20%, >20%
    let mut worst = 0.0f64;
    let mut worst_host = 0u32;
    let mut dumped = 0usize;

    for host_id in host_ids {
        let Ok(host) = decoder.decode_by_id(host_id) else { continue };
        if !matches!(
            host.ifc_type,
            IfcType::IfcWall | IfcType::IfcWallStandardCase | IfcType::IfcSlab | IfcType::IfcRoof
                | IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember | IfcType::IfcPlate
                | IfcType::IfcCovering | IfcType::IfcFooting
        ) {
            continue;
        }
        let _ = ifc_lite_geometry::rect_fast::take_param_fires();
        let Ok(result) = router.process_element_with_voids(&host, &mut decoder, &void_index) else {
            continue;
        };
        let fired = ifc_lite_geometry::rect_fast::take_param_fires();
        if fired == 0 {
            continue; // deferred to the exact kernel
        }
        total_fires += fired;
        fired_hosts += 1;
        if !watertight(&result) {
            wt_bad += 1;
            if wt_bad <= 8 {
                eprintln!("  NON-WATERTIGHT production output: host {host_id}");
            }
        }
        // GROUND TRUTH: param output volume vs the analytic box-minus-boxes (the exact
        // kernel is an imperfect oracle that over-cuts; analytic is exact for box hosts).
        let pv = mesh_volume(&result).abs();
        if let Some((truth, nb)) =
            analytic_cut_volume(&router, &host, &void_index[&host_id], &mut decoder)
        {
            let rel = (pv - truth).abs() / truth.max(1.0e-9);
            hist[if rel < 0.005 { 0 } else if rel < 0.02 { 1 } else if rel < 0.05 { 2 }
                else if rel < 0.20 { 3 } else { 4 }] += 1;
            if rel > 0.05 && dumped < 10 {
                dumped += 1;
                eprintln!("  MISMATCH host {host_id}: param_vol={pv:.4} truth={truth:.4} rel={rel:.4} n_boxes={nb}");
            }
            if rel > worst {
                worst = rel;
                worst_host = host_id;
            }
        }
    }

    ifc_lite_geometry::rect_fast::param_set_enabled_override(None);

    eprintln!("\n========= PARAM FAST PATH IN PRODUCTION =========");
    eprintln!("fixture            : {fixture}");
    eprintln!("hosts that FIRED   : {fired_hosts}   (total fires {total_fires})");
    eprintln!("non-watertight     : {wt_bad}");
    eprintln!("--- param-vs-GROUND-TRUTH (analytic) volume agreement (fired hosts) ---");
    for (l, c) in ["<0.5%", "0.5-2%", "2-5%", "5-20%", ">20%"].iter().zip(hist.iter()) {
        eprintln!("  {l:>7} : {c}");
    }
    eprintln!("worst rel-delta    : {worst:.4} (host {worst_host})");
    eprintln!("=================================================\n");

    assert!(
        fired_hosts > 0,
        "the parametric fast path must engage through the production pipeline"
    );
    assert_eq!(
        wt_bad, 0,
        "every fired host's production output must be watertight"
    );
    assert_eq!(
        hist[3] + hist[4],
        0,
        "every fired cut must match the analytic ground truth within 5%"
    );
}
