// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PHASE-0 CENSUS (read-only, no cut path): measures the two load-bearing numbers
//! that decide GO/NO-GO for a parametric placement-frame rectangular-opening fast path:
//!
//!   (a) R_opening == R_wall rate -- does the opening share the wall's exact placement
//!       frame (so the opening is axis-aligned in the wall frame, the fire precondition)?
//!   (b) parametric-box vs real-mesh agreement -- does the EXACT IfcRectangleProfileDef
//!       box equal the meshed wall's AABB IN THE WALL FRAME (the reconciliation gate)?
//!       A correct parametric R must axis-align the real mesh; the extent ratio is both
//!       the probe's self-check AND the gate metric.
//!
//! Run:
//!   MEASURE_FIXTURE=<path> cargo test --test rect_param_census -- --ignored --nocapture
//! No model path is baked in; point MEASURE_FIXTURE at the arch models to profile them.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh, RectParam};
use nalgebra::Matrix3;
use rustc_hash::FxHashMap;

const DEFAULT_FIXTURE: &str = "../../tests/models/buildingsmart/wall-with-opening-and-window.ifc";

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

/// AABB extents of `mesh` after rotating world positions into the frame `rt` (= R^T).
fn extents_in_frame(mesh: &Mesh, rt: &Matrix3<f64>) -> [f64; 3] {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for c in mesh.positions.chunks_exact(3) {
        let p = rt * nalgebra::Vector3::new(c[0] as f64, c[1] as f64, c[2] as f64);
        for k in 0..3 {
            mn[k] = mn[k].min(p[k]);
            mx[k] = mx[k].max(p[k]);
        }
    }
    [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
}

/// True iff `m` is a signed permutation matrix (each row one entry ~±1, rest ~0, and the
/// dominant columns are distinct) -- i.e. R_a and R_b share axes up to relabel/sign.
fn is_signed_permutation(m: &Matrix3<f64>, tol: f64) -> bool {
    let mut used = [false; 3];
    for i in 0..3 {
        let mut best = 0usize;
        let mut best_abs = 0.0;
        let mut second = 0.0;
        for j in 0..3 {
            let a = m[(i, j)].abs();
            if a > best_abs {
                second = best_abs;
                best_abs = a;
                best = j;
            } else if a > second {
                second = a;
            }
        }
        if best_abs < 1.0 - tol || second > tol || used[best] {
            return false;
        }
        used[best] = true;
    }
    true
}

fn sorted3(mut a: [f64; 3]) -> [f64; 3] {
    a.sort_by(|x, y| x.partial_cmp(y).unwrap());
    a
}

#[test]
#[ignore = "phase-0 census -- run explicitly with MEASURE_FIXTURE"]
fn parametric_rect_census() {
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

    // Host-level tallies.
    let mut hosts = 0usize;
    let mut host_probe_ok = 0usize; // host is a clean rect extrusion (probe Some)
    let mut host_box_match = 0usize; // parametric box ~= mesh AABB in frame (reconciliation pass)
    // Opening-level tallies (only for hosts whose probe succeeded -> R_host known).
    let mut openings = 0usize;
    let mut opening_probe_ok = 0usize;
    let mut opening_frame_match = 0usize;
    // The realistic fire ceiling: host probe ok + box matches + ALL openings frame-match.
    let mut fireable_hosts = 0usize;
    // vol(param)/vol(meshAABB-in-frame) histogram buckets.
    let mut vol_buckets = [0usize; 6]; // <0.5, .5-.9, .9-.98, .98-1.02, 1.02-1.1, >1.1
    let mut worst_axis_ratio_examples = 0usize;

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
        hosts += 1;

        let Some(hp): Option<RectParam> = router.parametric_rect_probe(&host, &mut decoder) else {
            // host is not a clean rect extrusion -> can't fire; still count its openings as N/A
            continue;
        };
        host_probe_ok += 1;
        let rt_host = hp.r.transpose();

        // Reconciliation: does the EXACT parametric box equal the real meshed wall in-frame?
        let mut this_host_box_ok = false;
        if let Ok(mesh) = router.process_element(&host, &mut decoder) {
            if !mesh.positions.is_empty() {
                let e = extents_in_frame(&mesh, &rt_host);
                let param = [hp.half[0] * 2.0, hp.half[1] * 2.0, hp.half[2] * 2.0];
                let ps = sorted3(param);
                let es = sorted3(e);
                let vol_param = ps[0] * ps[1] * ps[2];
                let vol_mesh = (es[0] * es[1] * es[2]).max(1e-12);
                let ratio = vol_param / vol_mesh;
                let b = if ratio < 0.5 { 0 } else if ratio < 0.9 { 1 }
                    else if ratio < 0.98 { 2 } else if ratio < 1.02 { 3 }
                    else if ratio < 1.1 { 4 } else { 5 };
                vol_buckets[b] += 1;
                // per-axis agreement within 2% (sorted, since axis labels may permute)
                let axis_ok = (0..3).all(|k| {
                    let lo = ps[k].min(es[k]);
                    let hi = ps[k].max(es[k]).max(1e-9);
                    lo / hi > 0.98
                });
                if axis_ok {
                    this_host_box_ok = true;
                    host_box_match += 1;
                } else if worst_axis_ratio_examples < 6 {
                    worst_axis_ratio_examples += 1;
                    eprintln!(
                        "  box-mismatch host {host_id}: param(sorted)={ps:?} mesh(sorted)={es:?} ratio={ratio:.3}"
                    );
                }
            }
        }

        // Openings: do they share the wall frame?
        let mut all_openings_match = true;
        let mut host_opening_count = 0usize;
        for &opening_id in &void_index[&host_id] {
            let Ok(opening) = decoder.decode_by_id(opening_id) else {
                all_openings_match = false;
                continue;
            };
            if opening.ifc_type != IfcType::IfcOpeningElement {
                continue;
            }
            host_opening_count += 1;
            openings += 1;
            let Some(op): Option<RectParam> = router.parametric_rect_probe(&opening, &mut decoder)
            else {
                all_openings_match = false;
                continue;
            };
            opening_probe_ok += 1;
            let m = rt_host * op.r;
            if is_signed_permutation(&m, 1.0e-3) {
                opening_frame_match += 1;
            } else {
                all_openings_match = false;
            }
        }

        if this_host_box_ok && host_opening_count > 0 && all_openings_match {
            fireable_hosts += 1;
        }
    }

    let pct = |n: usize, d: usize| if d == 0 { 0.0 } else { 100.0 * n as f64 / d as f64 };
    eprintln!("\n========= PHASE-0 PARAMETRIC RECT CENSUS =========");
    eprintln!("fixture                 : {fixture}");
    eprintln!("void hosts (bldg elems) : {hosts}");
    eprintln!("--------------------------------------------------");
    eprintln!("HOST is clean rect extrusion (probe ok) : {host_probe_ok} ({:.1}%)", pct(host_probe_ok, hosts));
    eprintln!("HOST param-box == mesh AABB (recon pass) : {host_box_match} ({:.1}% of probe-ok)", pct(host_box_match, host_probe_ok));
    eprintln!("--------------------------------------------------");
    eprintln!("openings probed                : {openings}");
    eprintln!("  opening clean rect (probe ok): {opening_probe_ok} ({:.1}%)", pct(opening_probe_ok, openings));
    eprintln!("  R_open == R_host (frame match): {opening_frame_match} ({:.1}% of all, {:.1}% of probe-ok)",
        pct(opening_frame_match, openings), pct(opening_frame_match, opening_probe_ok));
    eprintln!("--------------------------------------------------");
    eprintln!("FIREABLE hosts (probe+recon+all-openings-match): {fireable_hosts} ({:.1}% of hosts)", pct(fireable_hosts, hosts));
    eprintln!("--------- vol(param)/vol(meshAABB) histogram -----");
    let labels = ["<0.5", "0.5-0.9", "0.9-0.98", "0.98-1.02", "1.02-1.1", ">1.1"];
    for (i, l) in labels.iter().enumerate() {
        eprintln!("  {l:>9} : {}", vol_buckets[i]);
    }
    eprintln!("==================================================\n");
}
