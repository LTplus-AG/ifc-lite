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

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
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

/// Analytic ground-truth cut volume, computed from the LITERAL dimensions
/// baked into the `IFC` fixture above, independent of `parametric_rect_probe`
/// (#1552). The prior version derived "truth" by calling the very same
/// `router.parametric_rect_probe()` the code under test also uses, which is
/// self-referential: a systematic frame/axis bug in `parametric_rect_probe`
/// would corrupt both the "expected" and "actual" sides identically, so this
/// oracle must never call it (or anything that reuses its internals).
///
/// Derivation from the fixture's raw STEP parametrics (re-verify by hand
/// against the `IFC` string above if this ever needs to change):
///   - Host wall (#100): `IFCRECTANGLEPROFILEDEF` #130 is 4.0 (length) x 0.3
///     (thickness), extruded #140 depth 2.5 (height) -> box volume
///     4.0 * 0.3 * 2.5.
///   - Opening (#200): profile #227 is 1.0 (length) x 1.5 (height), extruded
///     #231 depth 1.0 along the opening's local Z, which axis #213/#214 map
///     to the WALL's thickness direction (Y). The opening's own placement
///     #211 sits at wall-local y=-0.5 and the 1.0 extrusion reaches y=+0.5,
///     i.e. it deliberately overshoots the wall's +/-0.15 half-thickness on
///     both sides so the cut always goes fully through, clamped by the host
///     to exactly the wall's 0.3 thickness. The opening is centred on the
///     host in length (wall-local x=0) and height (wall-local z=1.25, the
///     host's own z-centre), both well inside the host's extents, so neither
///     of those two axes is clamped.
///   - Clamped opening volume: 1.0 (length) * 1.5 (height) * 0.3 (thickness,
///     clamped from the oversized 1.0 extrusion down to the host).
///
/// A rigid rotation of the whole assembly (the fixture's wall is rotated
/// about Z in world space) does not change either volume, so this is exact
/// regardless of that rotation.
fn analytic_cut_volume() -> f64 {
    const WALL_LENGTH: f64 = 4.0;
    const WALL_THICKNESS: f64 = 0.3;
    const WALL_HEIGHT: f64 = 2.5;
    const OPENING_LENGTH: f64 = 1.0;
    const OPENING_HEIGHT: f64 = 1.5;
    // The opening's extrusion overshoots the host on both faces, so the
    // clamped cut depth is the full host thickness, not the raw 1.0 extrusion.
    let clamped_opening_depth = WALL_THICKNESS;

    let host_vol = WALL_LENGTH * WALL_THICKNESS * WALL_HEIGHT;
    let opening_vol = OPENING_LENGTH * OPENING_HEIGHT * clamped_opening_depth;
    (host_vol - opening_vol).abs()
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
    // `PARAM_FIRES` (rect_fast.rs) is a process-global counter, so reading its
    // absolute value would be unsafe under cargo test's default parallel test
    // execution if this file ever grew a second `#[test]` sharing the process
    // (each `tests/*.rs` integration file is its own binary/process today, so
    // there is currently nothing else to race with here, but `serial_test` is
    // not a workspace dev-dependency, so we don't reach for `#[serial]`).
    // Snapshot-and-diff instead: `take_param_fires()` swaps the counter to 0
    // and returns the prior value, so draining immediately before the call
    // under test and reading again immediately after yields the DELTA
    // attributable to this one call, robust to any future concurrent user.
    let before_param_fires = ifc_lite_geometry::rect_fast::take_param_fires();
    let result = router
        .process_element_with_voids(&host, &mut decoder, &void_index)
        .expect("process wall with voids");
    // `take_param_fires()` already resets the counter on read, so the value
    // read here IS the delta accrued strictly between the two calls above.
    let emitted_param_cuts = ifc_lite_geometry::rect_fast::take_param_fires();
    assert_eq!(
        before_param_fires, 0,
        "unexpected pre-existing PARAM_FIRES count before the call under test"
    );

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
    let truth = analytic_cut_volume();
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
