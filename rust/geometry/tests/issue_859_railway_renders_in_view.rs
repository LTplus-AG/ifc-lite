// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test: after the geometry pipeline runs end-to-end on the
//! reporter's `linear-placement-of-signal.ifc`, every emitted mesh
//! must land within the JS-side renderer's `MAX_VALID_COORD = 10 km`
//! sanity filter (`apps/viewer/src/components/viewer/useGeometryStreaming.ts:75`).
//! If even one element's positions are still in raw MGA territory
//! (~452 270, ~4 539 403) the JS `computeBounds` filter drops every
//! vertex, returns `null`, and the camera-auto-fit stays at its
//! default frame — the viewer renders 33 meshes with 11 k verts to a
//! black viewport, which is exactly what the user reported on the
//! `feat/859-linear-placement` deploy preview.
//!
//! This test replicates the WASM streaming pipeline's RTC-detect →
//! set-rtc → process-each-element flow that lives in
//! `rust/wasm-bindings/src/api/gpu_meshes.rs::parse_meshes` so the
//! native build catches the same failure mode without needing a wasm
//! runtime. The assertion is the WASM build's MAX_REASONABLE_OFFSET
//! filter (`gpu_meshes.rs:307`, `MAX_REASONABLE_OFFSET = 50 km`) plus
//! the JS-side bound check, expressed in pure Rust.

use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/859_linear_placement_of_signal.ifc";

/// Matches `apps/viewer/src/components/viewer/useGeometryStreaming.ts:75`.
/// JS-side `computeBounds` drops any vertex whose abs > this threshold.
const MAX_VALID_COORD: f32 = 10_000.0;

/// Matches `rust/wasm-bindings/src/api/gpu_meshes.rs:307` — the WASM
/// streaming pipeline pre-filters meshes whose absolute coordinates
/// exceed this band.
const MAX_REASONABLE_OFFSET: f32 = 50_000.0;

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with("version https://git-lfs.github.com/spec/") => None,
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("issue-859 fixture missing — skipping (run `pnpm fixtures`)");
            None
        }
        Err(e) => panic!("failed to read fixture: {e}"),
    }
}

#[test]
fn railway_meshes_land_within_renderer_valid_coord_band() {
    let Some(content) = read_fixture() else { return };

    // === Replicate WASM streaming setup exactly ============================
    // 1. Build router with file units.
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);

    // 2. Detect RTC offset from first geometry-bearing elements.
    let rtc_offset = router.detect_rtc_offset_from_first_element(&content, &mut decoder);
    let needs_shift = rtc_offset.0.abs() > 10_000.0
        || rtc_offset.1.abs() > 10_000.0
        || rtc_offset.2.abs() > 10_000.0;
    eprintln!(
        "detect_rtc_offset_from_first_element → ({:.2}, {:.2}, {:.2}); needs_shift={needs_shift}",
        rtc_offset.0, rtc_offset.1, rtc_offset.2,
    );

    // Hard assertion: the railway fixture's coords are MGA-territory
    // so RTC detection MUST flag it as needing a shift. If this fails,
    // the placement-translation sampling didn't see the linearly-
    // placed elements' world positions and the entire downstream
    // pipeline ships raw 4 539 403 m coords.
    assert!(
        needs_shift,
        "RTC detection returned ({:.2}, {:.2}, {:.2}) — the railway's MGA placement should \
         have been sampled and reported a 10 km+ shift. If detection skipped the linearly- \
         placed entities (which IS the railway's only geometry), every downstream mesh stays \
         in raw world coords and the JS renderer's MAX_VALID_COORD filter drops them all → \
         viewport stays empty.",
        rtc_offset.0, rtc_offset.1, rtc_offset.2,
    );

    if needs_shift {
        router.set_rtc_offset(rtc_offset);
    }

    // 3. Scan geometry-bearing entities and process each one — same
    //    loop the WASM build runs in `parse_meshes`.
    let mut scanner = EntityScanner::new(&content);
    let mut emitted_meshes: Vec<(u32, String, ifc_lite_geometry::Mesh)> = Vec::new();

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !has_geometry_by_name(type_name) {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };

        let has_rep = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
        if !has_rep && !is_alignment {
            continue;
        }

        let mesh = match router.process_element(&entity, &mut decoder) {
            Ok(m) if !m.positions.is_empty() => m,
            _ => continue,
        };
        emitted_meshes.push((id, entity.ifc_type.name().to_string(), mesh));
    }

    eprintln!("pipeline emitted {} non-empty meshes", emitted_meshes.len());
    assert!(
        !emitted_meshes.is_empty(),
        "pipeline emitted zero meshes — the linearly-placed elements all degenerated.",
    );

    // === Assertion 1: every per-mesh bbox sits inside the WASM filter ======
    // The WASM build's `push_mesh_if_valid` excludes any mesh whose max
    // coordinate magnitude exceeds MAX_REASONABLE_OFFSET * 4 (= 200 km).
    // If a railway signal at MGA (452 600, 4 539 528) bypassed RTC, it
    // would be filtered here and never even ship to the renderer.
    let mut outlier_meshes = Vec::new();
    for (id, ty, m) in &emitted_meshes {
        let (lo, hi) = m.bounds();
        let max_abs = lo.x.abs().max(lo.y.abs()).max(lo.z.abs())
            .max(hi.x.abs()).max(hi.y.abs()).max(hi.z.abs());
        if max_abs > MAX_REASONABLE_OFFSET * 4.0 || !max_abs.is_finite() {
            outlier_meshes.push((*id, ty.clone(), max_abs));
        }
    }
    assert!(
        outlier_meshes.is_empty(),
        "{} meshes have coords > {} m (WASM safety filter band) — RTC didn't apply on the \
         producer side, so the WASM build filters them out and the user sees an empty \
         viewport. First few: {:?}",
        outlier_meshes.len(),
        MAX_REASONABLE_OFFSET * 4.0,
        outlier_meshes.iter().take(3).collect::<Vec<_>>(),
    );

    // === Assertion 2: the combined-scene bbox sits inside the JS filter ====
    // The JS-side `computeBounds` rejects any vertex whose absolute
    // coordinate exceeds `MAX_VALID_COORD = 10 km`. If even one mesh
    // ships at raw MGA territory, the JS reducer skips its vertices
    // and the combined bounds shrink — in the worst case to `null`
    // (when EVERY vertex is filtered) → no camera fit → black viewport.
    let mut combined_lo = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut combined_hi = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    let mut included_vertex_count = 0usize;
    let mut filtered_vertex_count = 0usize;
    for (_, _, m) in &emitted_meshes {
        for chunk in m.positions.chunks_exact(3) {
            let (x, y, z) = (chunk[0], chunk[1], chunk[2]);
            if x.abs() < MAX_VALID_COORD && y.abs() < MAX_VALID_COORD && z.abs() < MAX_VALID_COORD {
                if x < combined_lo.0 { combined_lo.0 = x; }
                if y < combined_lo.1 { combined_lo.1 = y; }
                if z < combined_lo.2 { combined_lo.2 = z; }
                if x > combined_hi.0 { combined_hi.0 = x; }
                if y > combined_hi.1 { combined_hi.1 = y; }
                if z > combined_hi.2 { combined_hi.2 = z; }
                included_vertex_count += 1;
            } else {
                filtered_vertex_count += 1;
            }
        }
    }

    let total_verts = included_vertex_count + filtered_vertex_count;
    eprintln!(
        "after JS MAX_VALID_COORD filter: {} / {} verts pass, combined bounds=({:.2}, {:.2}, {:.2})→({:.2}, {:.2}, {:.2})",
        included_vertex_count, total_verts,
        combined_lo.0, combined_lo.1, combined_lo.2,
        combined_hi.0, combined_hi.1, combined_hi.2,
    );

    assert!(
        included_vertex_count > 0,
        "ZERO vertices passed the JS MAX_VALID_COORD={} m filter — `computeBounds(geometry)` \
         would return null and the camera auto-fit gets skipped. ALL {} verts were dropped \
         because their absolute coords exceeded {} m, meaning the geometry pipeline didn't \
         apply RTC. THIS IS THE ROOT CAUSE OF THE USER'S 'viewport blank with 33 meshes' \
         report.",
        MAX_VALID_COORD, total_verts, MAX_VALID_COORD,
    );

    assert!(
        filtered_vertex_count == 0,
        "{} of {} verts were dropped by the JS MAX_VALID_COORD={} m filter. Partial drop is \
         worse than total drop because the camera fits to the surviving subset, hiding the \
         missing elements without any visible error.",
        filtered_vertex_count, total_verts, MAX_VALID_COORD,
    );

    let span_x = combined_hi.0 - combined_lo.0;
    let span_y = combined_hi.1 - combined_lo.1;
    let span_z = combined_hi.2 - combined_lo.2;
    let max_size = span_x.max(span_y).max(span_z);
    assert!(
        max_size > 0.0 && max_size.is_finite(),
        "combined bounds collapsed to a zero-size box ({}, {}, {}) — \
         `computeBounds` returns null when maxSize <= 0, and the camera fit is skipped.",
        span_x, span_y, span_z,
    );
    eprintln!("combined bbox max span = {:.2} m — camera auto-fit has something to focus on", max_size);
}
