// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1007 — `roof_brep_opening_winding.ifc`: two INDEPENDENT pure-Rust
//! kernel defects, both reproduced on the real fixture and fixed here. Runs
//! under `--no-default-features` (pure-Rust kernel, NO Manifold).
//!
//! ## Defect A — gable-wall clip slivers
//! The gable `IfcWallStandardCase` bodies are an `IfcExtrudedAreaSolid` clipped
//! by 2–4 `IfcPolygonalBoundedHalfSpace` roof slopes. Their profile is authored
//! **CW**, so the extrusion's side walls were wound OPPOSITE to its caps — a
//! closed but winding-INCONSISTENT solid. The exact-kernel boolean (which
//! assumes consistent outward winding) then left open rim edges along the roof
//! cut + an inverted-volume surface, rendered as an un-clipped wedge above the
//! roofline. Fixed by (1) emitting consistently-wound extrusion side walls and
//! (2) orienting every kernel operand outward by its signed-volume sign.
//!
//! ## Defect B — uncut faceted-brep openings
//! The roof host (`#1112`, an `IfcFacetedBrep`) is voided by two openings
//! (`#2150`/`#2154`) that are *tilted* clean boxes (slanted to the roof slope).
//! They were classified `DiagonalRectangular` and cut by a frame-rotated AABB
//! that tore the host and left the void SOLID. Fixed by routing diagonal
//! openings through the exact mesh subtract (like `NonRectangular`), which cuts
//! the tilted boxes cleanly under the pure-Rust kernel.
//!
//! Both fixes are exact + determinism-safe and match the Manifold-oracle volume
//! to 4 decimals. We assert FUNCTIONAL correctness — the void is actually
//! removed (volume drops to the cut value) and the clip is not inverted /
//! under-removed — rather than exact 2-manifoldness: the shipped path runs
//! `consolidate_coplanar`, which (as for every gable wall in the corpus, e.g.
//! AC20-FZK-Haus) emits T-junctioned faces that are not edge-paired but render
//! correctly double-sided; gating on signed volume + orientation + ridge cap is
//! what actually distinguishes the two defects. The fixture is staged via
//! `pnpm fixtures`; the test SKIPS (stays green) when it is absent / an LFS
//! pointer.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityIndex, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::path::PathBuf;

const FIXTURE: &str = "issues/1007_roof_brep_opening_winding.ifc";

fn read_fixture() -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models")
        .join(FIXTURE);
    match std::fs::read_to_string(&path) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => {
            eprintln!("skipping: fixture {FIXTURE} is an LFS pointer — run `pnpm fixtures`");
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping: fixture {FIXTURE} not present — run `pnpm fixtures`");
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
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

fn signed_volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            let cr = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        / 6.0
}

fn process(content: &str, index: &EntityIndex, id: u32, voids: &FxHashMap<u32, Vec<u32>>) -> Mesh {
    let mut decoder = EntityDecoder::with_index(content, index.clone());
    let entity = decoder.decode_by_id(id).expect("decode element");
    let router = GeometryRouter::with_scale(1.0);
    router
        .process_element_with_voids(&entity, &mut decoder, voids)
        .unwrap_or_default()
}

/// Worst edge-length aspect ratio over the mesh (skipping fully-collapsed tris).
/// The #1007 diagonal sliver "flap" over the opening shows up as an extreme ratio
/// (raw kernel 66 205:1 / 259 997:1 on this fixture's two faceted-roof openings;
/// consolidate used to leave it). A cleanly-framed hole stays well under 10³:1.
fn worst_aspect(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    let d = |p: [f64; 3], q: [f64; 3]| {
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
    };
    let mut worst = 0.0_f64;
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        if mn > 1e-9 {
            worst = worst.max(mx / mn);
        }
    }
    worst
}

/// Defect B — the faceted-brep roof host has BOTH tilted-box openings actually
/// subtracted: its volume drops from the uncut solid (~185.5) to the
/// solid-minus-two-voids value (Manifold-oracle: 179.976). A solid (uncut) roof
/// — the reported bug — would keep volume ~185.5.
#[test]
fn faceted_brep_roof_openings_are_cut() {
    let Some(content) = read_fixture() else {
        return;
    };
    let index = build_entity_index(&content);
    let voids = build_void_index(&content);

    // Host roof #1112 is voided by openings #2150 + #2154 (both tilted clean
    // boxes, classified DiagonalRectangular).
    let host_id = 1112u32;
    assert!(
        voids.get(&host_id).map(|v| v.len()).unwrap_or(0) >= 2,
        "fixture changed: roof #{host_id} should host 2 openings, got {:?}",
        voids.get(&host_id)
    );

    // Reference: the SAME host with NO voids applied (the uncut solid).
    let uncut = process(&content, &index, host_id, &FxHashMap::default());
    let uncut_vol = signed_volume(&uncut);
    assert!(
        uncut_vol > 184.0 && uncut_vol < 187.0,
        "fixture changed: uncut roof #{host_id} volume = {uncut_vol:.4}, expected ~185.5",
    );

    let mesh = process(&content, &index, host_id, &voids);
    assert!(!mesh.is_empty(), "roof #{host_id} produced no mesh");
    let vol = signed_volume(&mesh);

    // The two ~6.5 m³ voids must be removed: volume drops to the oracle value.
    assert!(
        (vol - 179.976).abs() < 1.0e-2,
        "roof #{host_id} volume = {vol:.4}; expected ~179.976 (solid − both openings, \
         Manifold oracle). A value near {uncut_vol:.1} means the diagonal openings were \
         NOT subtracted (rendered SOLID — defect B regression).",
    );
    assert!(
        vol < uncut_vol - 5.0,
        "roof #{host_id} void cut removed too little: cut {vol:.4} vs uncut {uncut_vol:.4}",
    );
}

/// Defect B — the cut roof opening is FRAMED, not BRIDGED. The two
/// tilted faceted-brep openings used to leave a diagonal needle "flap" over the
/// hole: the exact kernel spanned a µm-scale near-duplicate rim vertex out to a
/// far roof corner (raw aspect 66 205:1 / 259 997:1; consolidate left 884 237:1
/// on the synthetic repro). The fix (a deterministic power-of-two near-coincident
/// weld + needle drop in `consolidate_coplanar`) frames the hole cleanly — the
/// worst aspect ratio collapses to the genuine-geometry floor (well under 10³:1).
#[test]
fn faceted_brep_roof_opening_has_no_spanning_sliver() {
    let Some(content) = read_fixture() else {
        return;
    };
    let index = build_entity_index(&content);
    let voids = build_void_index(&content);
    let host_id = 1112u32;

    let mesh = process(&content, &index, host_id, &voids);
    assert!(!mesh.is_empty(), "roof #{host_id} produced no mesh");

    let wa = worst_aspect(&mesh);
    assert!(
        wa < 1.0e3,
        "roof #{host_id} cut carries an opening-spanning sliver: worst aspect {wa:.0}:1 \
         (expected a cleanly-framed hole < 1000:1). The diagonal flap over the opening \
         is back (coplanar-overlap regression).",
    );
}

/// Defect A — every gable wall clipped by the segmented roof comes out
/// POSITIVELY oriented (not an inward-wound sliver), capped at the ridge
/// (z≈8.2), and at the Manifold-oracle volume (not under-removed). A CW-profile
/// extrusion used to tear here: inverted (negative) volume + an un-clipped wedge
/// above the roofline.
#[test]
fn gable_walls_clip_correctly_without_slivers() {
    let Some(content) = read_fixture() else {
        return;
    };
    let index = build_entity_index(&content);
    let voids = build_void_index(&content);

    // (express_id, expected oracle world volume, expected ridge-cap z-max).
    // #305/#313 are 2-cutter clips, #22/#338 are 4-cutter clips — all gable ends.
    let cases = [
        (305u32, 11.328f64, 8.2f32),
        (313, 11.328, 8.2),
        (22, 41.747, 8.2),
        (338, 41.747, 8.2),
    ];

    for (id, want_vol, want_zmax) in cases {
        let mesh = process(&content, &index, id, &voids);
        assert!(!mesh.is_empty(), "gable wall #{id} rendered EMPTY");

        // Positive orientation: the inward-wound base used to yield a NEGATIVE
        // signed volume (the sliver/inverted-surface defect).
        let vol = signed_volume(&mesh);
        assert!(
            vol > 0.0,
            "gable wall #{id} has NEGATIVE signed volume {vol:.4} — inward-wound (sliver) result",
        );
        // Correct magnitude: a larger-than-oracle volume means the roof clip
        // under-removed (the un-clipped wedge above the roofline).
        assert!(
            (vol - want_vol).abs() < 1.0e-2,
            "gable wall #{id} volume = {vol:.4}, expected ~{want_vol} (Manifold oracle). \
             A larger value means the roof clip under-removed (un-clipped wedge).",
        );
        // Ridge cap: the silhouette must stop at the roofline, not extrude through.
        let (_mn, mx) = mesh.bounds();
        assert!(
            (mx.z - want_zmax).abs() < 0.05,
            "gable wall #{id} max Z = {:.3}, expected ridge cap ~{want_zmax}",
            mx.z,
        );
    }
}
