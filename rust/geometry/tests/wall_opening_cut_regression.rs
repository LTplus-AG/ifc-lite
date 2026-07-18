// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for the wall-opening cut defect class (defect class 3 in
//! the calibration report). Documents real kernel defects discovered while
//! grounding the calibration claims against IfcOpenShell pip 0.8.2:
//!
//!   - #552611 and #552761 (2 openings each)  ✓ match IOS exactly
//!   - #555082 (1 opening)                     ✓ matches IOS exactly
//!   - #553010 (1 opening, 300 mm horizontal slot through full wall
//!     cross-section, body wrapped in `IfcBooleanClippingResult`) — produces
//!     an EMPTY mesh; IOS produces 24 verts / 40 tris.
//!   - #612315 (3 openings on a MW 11.5 wall) — produces 8 triangles AND the
//!     bbox extent has collapsed from `(11.839, 0.115, 3.406)` (IOS) to
//!     `(4.220, 0.115, 2.260)`; the booleans appear to have removed the
//!     entire wall outline and left only one fragment.
//!   - #555268 (7 openings, MappedItem-resolved wall) — produces 265
//!     triangles vs IOS's 124. Probable uncut residue from one of the
//!     openings; bbox still matches.
//!
//! The working cases here pin the production path so any future regression
//! re-emerging in the boolean kernel is caught. The failing cases stay
//! `#[ignore]` so they document the known-bad state without breaking CI;
//! once each defect is fixed its `#[ignore]` should be removed and the
//! assertions tightened to match IOS.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const FIXTURE: &str = "../../tests/models/ara3d/advanced_model.ifc";

/// Signed volume of the (closed) mesh via the divergence theorem — the
/// load-bearing geometric invariant alongside the bbox. Volumes below are
/// pinned against IfcOpenShell / the Manifold oracle (parity <= 3e-5 m3,
/// f32-import noise); a triangle-count pin alone could go stale while a
/// boolean corruption (inverted/open cut) shifts the volume.
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

/// Which void path these hosts take. The analytic prism cut (default) and the
/// exact kernel (`IFC_LITE_PRISM_CUT=0`) tessellate the same cut with the same
/// density class but different triangle counts, so the count pins below select
/// per path — the feature-off build must still reproduce the old exact-kernel
/// counts byte-for-byte. The bbox + oracle volume are the path-independent
/// load-bearing invariants and are asserted unconditionally.
fn prism_cut_enabled() -> bool {
    std::env::var("IFC_LITE_PRISM_CUT").as_deref() != Ok("0")
}

fn bbox(positions: &[f32]) -> Option<((f32, f32, f32), (f32, f32, f32))> {
    if positions.is_empty() {
        return None;
    }
    let mut mn = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut mx = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for c in positions.chunks_exact(3) {
        mn.0 = mn.0.min(c[0]);
        mn.1 = mn.1.min(c[1]);
        mn.2 = mn.2.min(c[2]);
        mx.0 = mx.0.max(c[0]);
        mx.1 = mx.1.max(c[1]);
        mx.2 = mx.2.max(c[2]);
    }
    Some((mn, mx))
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) =
                    (entity.get_ref(4), entity.get_ref(5))
                {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

fn process(host_id: u32) -> Option<Mesh> {
    if !std::path::Path::new(FIXTURE).exists() {
        // Match the `read_fixture` convention in processors/tests.rs so a
        // missing fixture surfaces a clear hint instead of silently passing
        // the test. CI always has the full fixture set.
        eprintln!(
            "skipping: fixture {} not present — run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)",
            FIXTURE,
        );
        return None;
    }
    let content = std::fs::read_to_string(FIXTURE).ok()?;
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_index = build_void_index(&content);
    let entity = decoder.decode_by_id(host_id).ok()?;
    assert!(matches!(
        entity.ifc_type,
        IfcType::IfcWall | IfcType::IfcWallStandardCase
    ));
    router
        .process_element_with_voids(&entity, &mut decoder, &void_index)
        .ok()
}

// ──────────────────────────── working cases ────────────────────────────

#[test]
fn wall_552611_2_openings_matches_ios() {
    let Some(mesh) = process(552611) else { return; };
    let (mn, mx) = bbox(&mesh.positions).expect("non-empty");
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);
    // IOS: v=32 t=60, min=(7.764,-0.620,0.094), ext=(0.200,8.404,10.506)
    // Geometry (bbox) is the load-bearing invariant; verify it FIRST.
    let tol = 0.001_f32;
    assert!((ext.0 - 0.200).abs() < tol, "ext.0 = {}", ext.0);
    assert!((ext.1 - 8.404).abs() < tol, "ext.1 = {}", ext.1);
    assert!((ext.2 - 10.506).abs() < tol, "ext.2 = {}", ext.2);
    // VOLUME is the cut-sensitive invariant: 16.942781 per the Manifold oracle
    // (uncut host 17.658, openings 0.353 + 0.363). The pre-fix kernel lost the
    // opening corner (5.142, 3.800) in `recover_subsegment` (its whole fan sat
    // inside a constraint channel) and over-cut this wall to 15.872.
    let vol = mesh_volume(&mesh);
    assert!((vol - 16.9428).abs() < 1e-3, "cut volume = {vol}, expected 16.9428");
    // Kernel re-baseline: `refine_high_aspect_slivers` (>8:1 bisection, corner
    // fix) inflates the count ~3x over IOS/Manifold's 60 — volume-preserving,
    // deterministic. Re-pinned 180 -> 188 when `consolidate_coplanar` switched
    // its plane buckets to a BTreeMap (target-independent emit order for the
    // mesh-determinism manifest): the refinement's first-seen canonical ids
    // follow mesh order, so its bisection cascade re-baselined; bbox + oracle
    // volume above are the load-bearing invariants and are unchanged.
    // Re-pinned 188 -> 204 for the analytic-prism void path (perf/beat-webifc):
    // the conforming per-triangle CDT + the same consolidate_coplanar +
    // refine_high_aspect_slivers post-passes tessellate the cut differently
    // from the exact arrangement but with the same density class. The count is
    // platform-stable for the same reason the exact pin was: FMA-free f64,
    // deterministic CDT / i_overlay, BTreeMap bucket order. Load-bearing
    // invariants remain the bbox + oracle volume above. Feature-off
    // (IFC_LITE_PRISM_CUT=0) routes back through the exact kernel: 188.
    let expect_tris = if prism_cut_enabled() { 204 } else { 188 };
    assert_eq!(
        mesh.indices.len() / 3,
        expect_tris,
        "triangle count (kernel-native, was IOS 60)"
    );
}

#[test]
fn wall_552761_2_openings_matches_ios() {
    let Some(mesh) = process(552761) else { return; };
    let (_mn, mx) = bbox(&mesh.positions).expect("non-empty");
    // Oracle volume 16.396679 (uncut 17.117, openings 0.7206 removed).
    let vol = mesh_volume(&mesh);
    assert!((vol - 16.3967).abs() < 1e-3, "cut volume = {vol}, expected 16.3967");
    // Kernel re-baseline (was IOS 60): ~3x from `refine_high_aspect_slivers`.
    // Re-pinned 188 -> 196 for the analytic-prism void path (see wall_552611's
    // pin note); bbox + oracle volume are the load-bearing invariants.
    // Feature-off (IFC_LITE_PRISM_CUT=0) routes back through the exact kernel: 188.
    let expect_tris = if prism_cut_enabled() { 196 } else { 188 };
    assert_eq!(mesh.indices.len() / 3, expect_tris);
    let _ = mx; // not used; presence of non-empty mesh is the assertion
}

#[test]
fn wall_555082_1_opening_matches_ios() {
    let Some(mesh) = process(555082) else { return; };
    let (_, _) = bbox(&mesh.positions).expect("non-empty");
    // Oracle volume 11.065037 (uncut 11.424, opening 0.359 removed).
    let vol = mesh_volume(&mesh);
    assert!((vol - 11.0650).abs() < 1e-3, "cut volume = {vol}, expected 11.0650");
    // Kernel re-baseline (IOS: v=20 t=36): ~3x from `refine_high_aspect_slivers`.
    // Re-pinned 114 -> 138 with the consolidate_coplanar BTreeMap bucket order
    // (see wall_552611 above); oracle volume is the load-bearing invariant.
    // Re-pinned 138 -> 130 for the analytic-prism void path (see wall_552611's
    // pin note) — the analytic cut consolidates BELOW the exact kernel here.
    // Feature-off (IFC_LITE_PRISM_CUT=0) routes back through the exact kernel: 138.
    let expect_tris = if prism_cut_enabled() { 130 } else { 138 };
    assert_eq!(mesh.indices.len() / 3, expect_tris);
}

// ──────────────────────────── known-bad cases ──────────────────────────
// These document calibration-report defects that the kernel still fails
// on. They remain `#[ignore]` until the boolean cut path is fixed; the
// assertions describe the IOS-correct output so the test becomes a
// concrete acceptance gate.

/// Wall #553010 carries a single opening whose authored extrusion direction
/// is +Z (the wall's height axis), not the wall thickness axis. The
/// opening is a 300 mm horizontal slab spanning the full wall cross-section.
/// Pre-fix, `extend_opening_along_direction` blindly extended the opening
/// along its authored extrusion direction to span the entire wall height,
/// consuming the host: `process_element_with_voids` returned an EMPTY
/// mesh.
///
/// Now the extension is gated on "opening projected extent along
/// extrusion ≤ wall's smallest bbox dimension × 1.05". When the
/// extrusion direction is the wrong axis (here: opening depth 0.300 m
/// exceeds wall thickness 0.200 m), extension is skipped and the
/// opening is subtracted with its authored extent.
#[test]
fn wall_553010_opening_does_not_empty_wall() {
    let mesh = process(553010).expect("fixture available");
    let (mn, mx) = bbox(&mesh.positions).expect(
        "opening cut wiped the entire wall — extend_opening_along_direction \
         is over-extending along the wrong axis again",
    );
    // The wall is 8.347 m long × 0.200 m thick × 10.506 m tall; the
    // horizontal slot at z ≈ 7 m doesn't change those overall extents.
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);
    let tol = 0.01_f32;
    assert!(
        (ext.0 - 0.200).abs() < tol && (ext.2 - 10.506).abs() < tol,
        "wall bbox extent shrunk after cut: got ({}, {}, {})",
        ext.0, ext.1, ext.2
    );
    // VOLUME pins the body clip + void cut: oracle 16.546800 (clipped body
    // 17.046647 minus the 0.4998 opening). The pre-fix PBHS prism builder
    // emitted BOTH end caps wound inward when the boundary contour arrived
    // clockwise (earcut normalises cap winding, the side walls follow the raw
    // contour order), leaking +0.018 and an unpaired quad into the body.
    let vol = mesh_volume(&mesh);
    assert!((vol - 16.5468).abs() < 1e-3, "cut volume = {vol}, expected 16.5468");
    // Cut produced a real wall-with-slot mesh, not the uncut host (12 tris).
    // Kernel-native count: 138 (`refine_high_aspect_slivers` splits the tall
    // wall faces around the slot); IOS produces 40 with coarser tessellation.
    let tris = mesh.indices.len() / 3;
    assert_eq!(tris, 138, "wall-with-slot triangle count");
}

/// Wall #612315 (MW 11.5, 3 openings) used to collapse to a 4.22 m fragment
/// because one of its openings (#612334) is a narrow column whose extruded
/// rectangle profile (3.4 m × 0.115 m) is extruded by only 115 mm, with an
/// `IfcAxis2Placement3D` Position transform that rotates local +Z to world
/// +X — the wall's 11.8 m long axis. Pre-fix, `extend_opening_along_direction`
/// stretched the opening to cover the full wall length and the cut wiped
/// most of the wall. After also fixing the cap-skip aspect-ratio threshold
/// (the wall itself was being emitted as a hollow tube), the cut now
/// produces a real wall-with-3-holes mesh covering the full host extent.
#[test]
fn wall_612315_bbox_must_not_collapse() {
    let mesh = process(612315).expect("fixture available");
    let (mn, mx) = bbox(&mesh.positions).expect("non-empty");
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);
    // IOS extent: (11.839, 0.115, 3.406). Pin all three axes — the prior
    // bug collapsed both length (X) and height (Z).
    let tol = 0.01_f32;
    assert!(
        (ext.0 - 11.839).abs() < tol,
        "wall length collapsed: got {} (expected 11.839)",
        ext.0
    );
    assert!((ext.1 - 0.115).abs() < tol);
    assert!(
        (ext.2 - 3.406).abs() < tol,
        "wall height collapsed: got {} (expected 3.406)",
        ext.2
    );
    // The cut must actually have happened — uncut box would be 12 tris.
    // Don't pin a specific count; ifc-lite emits 100, IOS emits 56 with
    // different tessellation choices for the same wall-with-3-holes
    // topology. Both are geometrically valid.
    let tris = mesh.indices.len() / 3;
    assert!(
        tris > 12,
        "wall has only {} tris — opening cuts didn't take effect",
        tris
    );
}

/// Wall #555268 carries 7 openings. Pre-fix, ifc-lite emitted 265 triangles
/// with a wall extent of (21.997, 0.200, 3.200) — bbox already matched IOS,
/// but the post-cap-skip-fix and post-extension-axis-fix tessellation
/// produces more reveal-face triangles. Pin the bbox; don't pin the
/// triangle count — IOS emits 124 with welded shared vertices, ifc-lite
/// emits 377 unwelded (defect class 3 in the calibration report covers
/// vertex welding separately).
#[test]
fn wall_555268_7_openings_cuts_take_effect() {
    let mesh = process(555268).expect("fixture available");
    let (mn, mx) = bbox(&mesh.positions).expect("non-empty");
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);
    let tol = 0.01_f32;
    assert!((ext.0 - 21.997).abs() < tol, "length: {}", ext.0);
    assert!((ext.1 - 0.200).abs() < tol, "thickness: {}", ext.1);
    assert!((ext.2 - 3.200).abs() < tol, "height: {}", ext.2);
    let tris = mesh.indices.len() / 3;
    // Uncut box is 12. Wall with 7 holes cut should produce ≥ ~80 tris
    // (rough lower bound: 12 base + 7 openings × ~8 reveal faces ≈ 68).
    assert!(
        tris > 60,
        "wall has only {} tris — opening cuts didn't take effect for 7 openings",
        tris
    );
    let _ = mn;
}

/// Wall #555433 ("Muro básico:STB 30") carries 3 openings, one of which
/// (#555493) is a non-rectangular facade-scale void whose world-aligned
/// bounding box engulfs the wall on every axis while its real profile excludes
/// the wall. The Manifold kernel errors on the grazing/coplanar cutter and
/// returns the un-cut host — which is the correct result (IfcOpenShell keeps the
/// wall) — but the recorded failure used to trigger the rectangular AABB
/// fallback, which cut the engulfing box and collapsed the wall to a 1.5%-volume
/// sliver (bbox_iou 0.01 vs IOS). The near-engulf guard now keeps the un-cut
/// host when CSG produced no change and the opening engulfs the wall. The wall
/// is ~0.30 × 9.015 × 4.292 m; assert it survives at near-full extent.
#[test]
fn wall_555433_engulfing_opening_does_not_collapse_wall() {
    let Some(mesh) = process(555433) else { return };
    let (mn, mx) = bbox(&mesh.positions).expect(
        "engulfing-opening fallback deleted the wall — the near-engulf guard in \
         apply_void_context regressed",
    );
    let ext = (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2);
    // IfcOpenShell keeps the full wall extent (0.30, 9.015, 4.292); the two
    // genuine small openings don't change it. Require no collapse.
    assert!(
        ext.1 > 8.5 && ext.2 > 4.0,
        "wall collapsed after engulfing-opening cut: extent ({}, {}, {})",
        ext.0, ext.1, ext.2
    );
    let _ = mn;
}
