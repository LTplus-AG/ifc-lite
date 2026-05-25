// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-fixture CSG quality regression.
//!
//! The bath defect that motivated this suite (issue #780) was a class of
//! BSP-CSG output where the kernel split a host face along its 2-triangle
//! diagonal at every extended cutter plane, producing long sliver
//! triangles radiating from the cavity rim. The fix was a coplanar
//! pre/post-merge pipeline plus removal of an over-aggressive
//! "strictly-inside-host" filter that was nuking the cavity floor.
//!
//! These tests are NOT about element-specific behaviour (those live in the
//! `wall_opening_cut_regression`, `door_window_calibration_regression`,
//! `issue_635_*` suites already). They are a single, fast cross-fixture
//! gate: process a handful of known-CSG-heavy elements from AC20-FZK-Haus,
//! duplex, advanced_model, and the issue-#780 bath, and assert that the
//! emitted geometry has no extreme-aspect-ratio sliver triangles.
//!
//! If this test starts failing, the CSG output-quality pipeline has
//! regressed somewhere — most likely the coplanar consolidation or the
//! collinear simplification in `ClippingProcessor::consolidate_coplanar`.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::path::PathBuf;

fn fixture(rel: &str) -> Option<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(rel);
    std::fs::read_to_string(p).ok()
}

fn void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) =
                    (entity.get_ref(4), entity.get_ref(5))
                {
                    idx.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut idx, content, &mut decoder);
    idx
}

fn process(content: &str, host_id: u32, use_voids: bool) -> Option<Mesh> {
    let ei = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, ei);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_units(content, &mut decoder);
    if use_voids {
        let idx = void_index(content);
        router.process_element_with_voids(&entity, &mut decoder, &idx).ok()
    } else {
        router.process_element(&entity, &mut decoder).ok()
    }
}

/// Aspect ratio of the worst triangle in a mesh (longest edge / shortest
/// edge). Slivers from BSP plane-splitting at host face diagonals can hit
/// 50:1 or higher; a clean mesh of building geometry sits comfortably
/// under 20:1.
fn worst_aspect_ratio(mesh: &Mesh) -> (f32, usize) {
    let mut worst: f32 = 0.0;
    let mut spike_count = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let p: [[f32; 3]; 3] = [
            [
                mesh.positions[tri[0] as usize * 3],
                mesh.positions[tri[0] as usize * 3 + 1],
                mesh.positions[tri[0] as usize * 3 + 2],
            ],
            [
                mesh.positions[tri[1] as usize * 3],
                mesh.positions[tri[1] as usize * 3 + 1],
                mesh.positions[tri[1] as usize * 3 + 2],
            ],
            [
                mesh.positions[tri[2] as usize * 3],
                mesh.positions[tri[2] as usize * 3 + 1],
                mesh.positions[tri[2] as usize * 3 + 2],
            ],
        ];
        let d = |a: [f32; 3], b: [f32; 3]| -> f32 {
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };
        let e0 = d(p[0], p[1]);
        let e1 = d(p[1], p[2]);
        let e2 = d(p[2], p[0]);
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        if mn > 1.0e-6 {
            let ratio = mx / mn;
            worst = worst.max(ratio);
            if ratio > 50.0 {
                spike_count += 1;
            }
        }
    }
    (worst, spike_count)
}

fn assert_no_spikes(mesh: &Mesh, label: &str) {
    assert!(!mesh.indices.is_empty(), "{}: empty mesh", label);
    let (worst, n) = worst_aspect_ratio(mesh);
    assert_eq!(
        n, 0,
        "{}: {} spike triangles (aspect > 50:1, worst {:.1}:1) — CSG output quality regressed",
        label, n, worst
    );
}

fn find_first_entity_id(content: &str, type_upper: &str) -> Option<u32> {
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if name == type_upper {
            return Some(id);
        }
    }
    None
}

// ─────────────────────────── AC20-FZK-Haus ────────────────────────────

/// Wand-Ext-OG-1 — a gable wall whose body is
/// `IfcBooleanClippingResult(.DIFFERENCE., extrusion, polygonal-bounded-
/// halfspace)` chained twice (one clip per roof slope). Exercises the
/// "collect chained polygonal half-spaces and apply as one CSG op" fast
/// path in `BooleanClippingProcessor::process_with_depth`. Without the
/// coplanar pre-merge, this used to leave sliver triangles around the
/// gable apex.
#[test]
fn fzk_haus_gable_wall_60012_no_spike_triangles() {
    let Some(content) = fixture("tests/models/ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let mesh = process(&content, 60012, true).expect("process wall #60012");
    assert_no_spikes(&mesh, "FZK-Haus wall #60012 (gable)");
}

#[test]
fn fzk_haus_gable_wall_67828_no_spike_triangles() {
    let Some(content) = fixture("tests/models/ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let mesh = process(&content, 67828, true).expect("process wall #67828");
    assert_no_spikes(&mesh, "FZK-Haus wall #67828 (gable)");
}

// ────────────────────── known-bad: opening-cut path ───────────────────
//
// The next three elements all currently emit sliver triangles that the
// CSG output-quality guard would flag, but the slivers come from BEFORE
// the BSP/Manifold kernel — either the input profile tessellation
// (multi-extrusion windows) or the rectangular-box cut helper
// (`cut_multiple_rectangular_openings` in `router/voids.rs`), which has
// its own clipping that bypasses `ClippingProcessor::consolidate_coplanar`.
//
// Identical spike counts appear under both BSP and Manifold kernels,
// confirming the kernel is not at fault. Left `#[ignore]`d with the
// current spike-count baseline so the suite documents the issue and
// becomes a tightening gate when the upstream paths are cleaned up
// (mirrors the same convention as the `#[ignore]`d cases in
// `wall_opening_cut_regression.rs`).

/// duplex window #6426 — multi-extrusion (frame + sash + glass + lining)
/// produces 72 spike triangles (worst ratio ~392:1) on both kernels.
/// Origin: profile tessellation of overlapping narrow extrusions, not
/// the CSG kernel.
#[test]
#[ignore = "pre-existing: 72 spike tris from multi-extrusion profile tessellation, not the CSG kernel"]
fn duplex_window_6426_no_spike_triangles() {
    let Some(content) = fixture("tests/models/ara3d/duplex.ifc") else {
        return;
    };
    let mesh = process(&content, 6426, false).expect("process window #6426");
    assert_no_spikes(&mesh, "duplex window #6426");
}

/// advanced_model wall #553010 — 8 spike tris (worst ~198:1), produced
/// in the rectangular-opening clip path.
#[test]
#[ignore = "pre-existing: 8 spike tris from `cut_multiple_rectangular_openings`, not the CSG kernel"]
fn advanced_model_wall_553010_no_spike_triangles() {
    let Some(content) = fixture("tests/models/ara3d/advanced_model.ifc") else {
        return;
    };
    let mesh = process(&content, 553010, true).expect("process wall #553010");
    assert_no_spikes(&mesh, "advanced_model wall #553010");
}

/// advanced_model wall #612315 — 23 spike tris with worst ratio
/// ~3077:1 (!). The opening-cut path leaves long degenerate slivers in
/// the MW 11.5 wall. Worth fixing as a separate follow-up, but unrelated
/// to the CSG kernel and to this audit.
#[test]
#[ignore = "pre-existing: 23 spike tris (worst 3077:1) in the opening-cut helper, not the CSG kernel"]
fn advanced_model_wall_612315_no_spike_triangles() {
    let Some(content) = fixture("tests/models/ara3d/advanced_model.ifc") else {
        return;
    };
    let mesh = process(&content, 612315, true).expect("process wall #612315");
    assert_no_spikes(&mesh, "advanced_model wall #612315");
}

// ─────────────────────────────── bath #780 ────────────────────────────

/// The originating defect: `IfcCsgSolid(IfcBooleanResult(IfcBlock,
/// IfcExtrudedAreaSolid(IfcRoundedRectangleProfileDef)))`. Pre-fix this
/// emitted 189 triangles with two spikes radiating from a rounded corner
/// to the bath outer edge along the bath top face's pre-existing
/// diagonal. The bath-specific suite already covers triangle budget +
/// volume; this entry keeps the cross-fixture guard symmetric.
#[test]
fn bath_780_no_spike_triangles() {
    let Some(content) = fixture("rust/geometry/tests/fixtures/bath_csg_solid.ifc") else {
        return;
    };
    let bath_id = find_first_entity_id(&content, "IFCSANITARYTERMINAL")
        .expect("bath product present");
    let mesh = process(&content, bath_id, false).expect("process bath");
    assert_no_spikes(&mesh, "bath #780");
}
