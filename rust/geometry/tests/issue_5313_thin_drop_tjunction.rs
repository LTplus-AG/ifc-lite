// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #5313: the router's source hygiene (`Mesh::clean_degenerate`)
//! dropped a sub-grid collinear cap sliver whose apex the side walls still
//! used, opening a T-junction in a closed extrusion.
//!
//! `ifcopenshell/928-column.ifc` #120 and `1019-column.ifc` #126 are Revit
//! columns whose `IfcArbitraryClosedProfileDef` outline is an
//! `IfcCompositeCurve` carrying a 7.46 mm `IfcTrimmedCurve` arc on a 117 m
//! circle. The arc discretizes to A, M, C with M ~5.9e-8 m off the chord, so
//! earcut's cap triangle (A, C, M) is below `SNAP_GRID`. Before the fix each
//! column came out of `process_element` with 6 open edges (A-C on both caps
//! against the wall edges A-M and M-C).

mod support;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use std::collections::HashMap;
use std::path::PathBuf;

fn fixture(rel: &str) -> Option<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel);
    match std::fs::read_to_string(&p) {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            assert!(
                !support::require_fixtures(),
                "fixture {} not present and IFC_LITE_REQUIRE_FIXTURES=1 -- run `pnpm fixtures` to download (sha256 in tests/models/manifest.json)",
                p.display()
            );
            eprintln!("skipping #5313 regression: {} missing -- run `pnpm fixtures`", p.display());
            None
        }
        Err(e) => panic!("fixture {} exists but could not be read: {e}", p.display()),
    }
}

/// Undirected edges not shared by exactly two triangles, vertices keyed by
/// exact f32 bits: cap and wall copies of one profile point are computed
/// through the same transform, so a closed solid returns 0 with no tolerance.
fn open_edges(m: &Mesh) -> usize {
    let key = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b].to_bits(), m.positions[b + 1].to_bits(), m.positions[b + 2].to_bits()]
    };
    let mut edges: HashMap<_, u32> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ka, kb) = (key(a), key(b));
            *edges.entry(if ka < kb { (ka, kb) } else { (kb, ka) }).or_insert(0) += 1;
        }
    }
    edges.values().filter(|&&c| c != 2).count()
}

#[test]
fn composite_curve_tiny_arc_columns_stay_closed() {
    for (rel, id) in [
        ("tests/models/ifcopenshell/928-column.ifc", 120u32),
        ("tests/models/ifcopenshell/1019-column.ifc", 126u32),
    ] {
        let Some(content) = fixture(rel) else { continue };
        let index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, index);
        let entity = decoder.decode_by_id(id).expect("decode column");
        let mesh = GeometryRouter::with_scale(1.0)
            .process_element(&entity, &mut decoder)
            .unwrap_or_else(|e| panic!("{rel} #{id} should process: {e}"));
        assert!(!mesh.is_empty(), "{rel} #{id} produced no geometry");
        assert_eq!(open_edges(&mesh), 0, "{rel} #{id}: column must be closed (6 open edges before #5313)");
    }
}
