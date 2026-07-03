// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! HERMETIC CI gate for the parametric rect-opening fast path (#1493 flipped
//! `IFC_LITE_RECT_PARAM` default ON). The corpus A/B validators
//! (`rect_param_validate`/`parity`/`production`) all need external models and
//! are `#[ignore]`, so nothing guarded the shipped default in CI. This test
//! runs on the shipped default with a tiny INLINE rotated rectangular wall +
//! rectangular opening (no fixture fetch), and asserts the analytic cut FIRES,
//! is watertight, and matches the analytic box-minus-box ground truth. A
//! regression that makes the param path silently defer or miscut fails here.
//!
//! It reads the ROUTER-LOCAL `take_rect_fast_stats().fired` (race-free per
//! router) to assert the analytic cut ENGAGED, plus the process-global
//! `take_param_fires()` to assert it was EMITTED (that counter increments only
//! after the watertight self-check passes, so it proves the fast-path mesh was
//! kept, not discarded to the exact kernel). The global counter is drained
//! immediately before the single process call, scoping the read to this host.

use ifc_lite_core::{build_entity_index, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh, RectParam};
use nalgebra::Matrix3;
use rustc_hash::FxHashMap;

/// Rotated (36.87 deg in plan, NON-axis-aligned so the world path defers and
/// the placement-frame parametric path is what must fire) rectangular wall,
/// 4.0 x 0.3 x 2.5 m, voided by one rectangular opening 1.0(len) x 1.5(height)
/// cut straight through the 0.3 thickness, centred in the face with a wide
/// margin (so it is on-face, through, and not near-edge -> the fire gate opens).
/// Metre units, identity site (unit_scale 1, RTC 0) so the analytic volume is
/// trivial to check.
const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('rect-param gate fixture'),'2;1');
FILE_NAME('rect_param_gate.ifc','2026-07-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0RectParamGate000000A',$,'RectParamGate',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#110=IFCLOCALPLACEMENT($,#111);
#111=IFCAXIS2PLACEMENT3D(#12,#112,#113);
#112=IFCDIRECTION((0.,0.,1.));
#113=IFCDIRECTION((0.8,0.6,0.));
#130=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#131,4.0,0.3);
#131=IFCAXIS2PLACEMENT2D(#132,#133);
#132=IFCCARTESIANPOINT((0.,0.));
#133=IFCDIRECTION((1.,0.));
#140=IFCEXTRUDEDAREASOLID(#130,#141,#142,2.5);
#141=IFCAXIS2PLACEMENT3D(#12,$,$);
#142=IFCDIRECTION((0.,0.,1.));
#150=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140));
#151=IFCPRODUCTDEFINITIONSHAPE($,$,(#150));
#100=IFCWALL('0RectParamGateWall00A',$,'Wall',$,$,#110,#151,$,$);
#210=IFCLOCALPLACEMENT(#110,#211);
#211=IFCAXIS2PLACEMENT3D(#212,#213,#214);
#212=IFCCARTESIANPOINT((0.,-0.5,1.25));
#213=IFCDIRECTION((0.,1.,0.));
#214=IFCDIRECTION((1.,0.,0.));
#227=IFCRECTANGLEPROFILEDEF(.AREA.,'Opening',#228,1.0,1.5);
#228=IFCAXIS2PLACEMENT2D(#132,#133);
#231=IFCEXTRUDEDAREASOLID(#227,#141,#142,1.0);
#240=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#231));
#241=IFCPRODUCTDEFINITIONSHAPE($,$,(#240));
#200=IFCOPENINGELEMENT('0RectParamGateOpen00A',$,'Opening',$,$,#210,#241,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0RectParamGateVoid00A',$,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#;

const HOST_ID: u32 = 100;

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

fn mesh_volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let v = |i: u32| {
                let b = i as usize * 3;
                [
                    mesh.positions[b] as f64,
                    mesh.positions[b + 1] as f64,
                    mesh.positions[b + 2] as f64,
                ]
            };
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

/// Watertight = every undirected edge shared by exactly two triangles.
fn watertight(mesh: &Mesh) -> (bool, usize, usize) {
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
    let bad = edges.values().filter(|&&c| c != 2).count();
    (!edges.is_empty() && bad == 0, edges.len(), bad)
}

/// Signed-permutation axis map of `m` (each row one entry ~ +/-1), or `None`.
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

/// Analytic ground-truth cut volume: host box minus the opening box clamped to
/// the host. Exact for a box-minus-box; reads both frames from the parametrics.
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
        for b in router.parametric_rect_probe_all(&opening, decoder)? {
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

#[test]
fn param_fast_path_fires_watertight_and_matches_analytic_on_the_shipped_default() {
    let entity_index = build_entity_index(IFC);
    let mut decoder = EntityDecoder::with_index(IFC, entity_index);
    // Fresh per-test router: its rect-fast stats are request-local, so `fired`
    // cannot be polluted by other tests running in parallel.
    let router = GeometryRouter::with_units(IFC, &mut decoder);
    let void_index = build_void_index(IFC, &mut decoder);
    assert!(
        void_index.contains_key(&HOST_ID),
        "fixture rot: the wall must be a void host"
    );

    let host = decoder.decode_by_id(HOST_ID).expect("decode wall");
    // Drain the global "emitted" counter immediately before the single process
    // call so what we read back is this host's post-self-check emissions.
    let _ = ifc_lite_geometry::rect_fast::take_param_fires();
    let result = router
        .process_element_with_voids(&host, &mut decoder, &void_index)
        .expect("process wall with voids");
    let emitted_param_cuts = ifc_lite_geometry::rect_fast::take_param_fires();

    // (a) The shipped default (param ON) must both ENGAGE and EMIT the analytic
    // cut on this rotated rectangular wall (exactly the case #1493 targets, which
    // no committed test previously exercised).
    //  - `stats.fired` (router-local, race-free) is recorded in
    //    `subtract_rect_openings`, i.e. as soon as the analytic cut is ATTEMPTED.
    //  - `param_record_fire`/`take_param_fires` (voids/mod.rs) increments only
    //    AFTER the watertight self-check passes, i.e. the fast-path mesh was
    //    actually EMITTED (not attempted then discarded to the exact kernel).
    // Asserting both means a regression that makes the cut fail the self-check
    // and silently fall back is caught, not just one that stops it engaging.
    let stats = router.take_rect_fast_stats();
    assert!(
        stats.fired > 0,
        "the parametric fast path must ENGAGE on a rotated rectangular wall with a \
         through rectangular opening (fired={}, defers: host_not_box={} not_through={} \
         off_face={} near_edge={} no_openings={})",
        stats.fired,
        stats.defer_host_not_box,
        stats.defer_not_through,
        stats.defer_off_face,
        stats.defer_near_edge,
        stats.defer_no_openings,
    );
    assert!(
        emitted_param_cuts > 0,
        "the parametric cut must be EMITTED (survive the watertight self-check), \
         not merely engaged then discarded to the exact kernel (emitted={emitted_param_cuts})"
    );

    // (b) Production safety invariant: a fired host's output is watertight.
    let (wt, edges, bad) = watertight(&result);
    assert!(wt, "fired cut must be watertight ({bad} bad edges over {edges})");

    // (c) Correctness: the fired cut matches the analytic box-minus-box ground
    // truth (encoded as agreement, NOT kernel bit-equality, since memory records
    // the param path as MORE correct than the exact kernel on such hosts).
    let pv = mesh_volume(&result).abs();
    let truth = analytic_cut_volume(&router, &host, &void_index[&HOST_ID], &mut decoder)
        .expect(
            "analytic ground truth requires the host + every opening to be an \
             axis-aligned rectangular box (the committed fixture is); a None here \
             means a fixture edit introduced a non-axis-aligned opening",
        );
    let rel = (pv - truth).abs() / truth.max(1.0e-9);
    assert!(
        rel < 0.02,
        "fired cut volume {pv:.5} must match analytic ground truth {truth:.5} within 2% (rel={rel:.4})"
    );

    // (d) DRY-drift pin: the host frame (parametric_rect_probe) and the cutter
    // frame source (parametric_rect_probe_all -> rect_param_from_item) share one
    // derivation. Assert the single-item host resolves identically both ways, so
    // a future re-fork of the two paths (the miscut risk this PR removed) fails.
    let via_probe = router.parametric_rect_probe(&host, &mut decoder).expect("host probe");
    let via_all = router
        .parametric_rect_probe_all(&host, &mut decoder)
        .expect("host probe_all");
    assert_eq!(via_all.len(), 1, "single-item host must yield one box");
    let a = &via_probe;
    let b = &via_all[0];
    assert!((a.center - b.center).norm() < 1e-12, "host center drift between probe paths");
    assert!((a.r - b.r).norm() < 1e-12, "host frame drift between probe paths");
    for i in 0..3 {
        assert!((a.half[i] - b.half[i]).abs() < 1e-12, "host half-extent drift between probe paths");
    }
}
