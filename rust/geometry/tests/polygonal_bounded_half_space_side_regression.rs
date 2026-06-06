// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: `IfcPolygonalBoundedHalfSpace` clip must remove the side the
//! `AgreementFlag` designates as material, regardless of how the cutter's
//! `Position.Z` axis is authored.
//!
//! duplex.ifc "Party Wall - CMU Residential" segments #4287 / #4399 are
//! rectangular walls (XDim 4.201, YDim 0.550, height 2.795) whose ends are
//! trimmed by two `IfcPolygonalBoundedHalfSpace` cutters. For the
//! Y-thickness cutter, `Position.Z` is authored parallel to the plane's
//! `+normal` while `AgreementFlag = TRUE` puts the material on `-normal`.
//!
//! The bounded-prism builder used to extrude the cutter prism along `+Position.Z`
//! unconditionally — i.e. AWAY from the material side — so the DIFFERENCE
//! kept the thin 0.057 m slice that should have been removed instead of the
//! 0.493 m bulk. IfcOpenShell (pip 0.8.2, use-world-coords) keeps the bulk:
//! extent (4.201, 0.493, 2.795). Pin that.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const FIXTURE: &str = "../../tests/models/ara3d/duplex.ifc";

fn bbox_extent(p: &[f32]) -> (f32, f32, f32) {
    let mut mn = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut mx = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for c in p.chunks_exact(3) {
        mn.0 = mn.0.min(c[0]);
        mn.1 = mn.1.min(c[1]);
        mn.2 = mn.2.min(c[2]);
        mx.0 = mx.0.max(c[0]);
        mx.1 = mx.1.max(c[1]);
        mx.2 = mx.2.max(c[2]);
    }
    (mx.0 - mn.0, mx.1 - mn.1, mx.2 - mn.2)
}

/// Process an element's geometry. Panics (fails the test loudly) on any
/// parse/decode/geometry error — only a *missing fixture* is a legitimate skip,
/// and that is checked by the caller before this runs.
fn process(id: u32) -> Mesh {
    let content =
        std::fs::read_to_string(FIXTURE).unwrap_or_else(|e| panic!("read {FIXTURE}: {e}"));
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let entity = decoder
        .decode_by_id(id)
        .unwrap_or_else(|e| panic!("decode #{id}: {e}"));
    router
        .process_element_with_voids(&entity, &mut decoder, &void_index)
        .unwrap_or_else(|e| panic!("process #{id}: {e}"))
}

#[test]
fn party_wall_polygonal_clip_keeps_material_side() {
    if !std::path::Path::new(FIXTURE).exists() {
        eprintln!("skipping: fixture {FIXTURE} not present — run `pnpm fixtures` to download");
        return;
    }
    for id in [4287u32, 4399u32] {
        let mesh = process(id);
        let ext = bbox_extent(&mesh.positions);
        // IOS reference: extent (4.201, 0.493, 2.795). Pre-fix Y collapsed to
        // 0.057 (kept the wrong half-space side).
        let tol = 0.01_f32;
        assert!(
            (ext.0 - 4.201).abs() < tol
                && (ext.1 - 0.493).abs() < tol
                && (ext.2 - 2.795).abs() < tol,
            "#{id}: polygonal half-space clip kept the wrong side — \
             extent {ext:?}, expected ~(4.201, 0.493, 2.795)"
        );
    }
}
