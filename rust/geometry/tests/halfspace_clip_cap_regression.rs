// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: an unbounded `IfcHalfSpaceSolid` DIFFERENCE must yield a
//! watertight, correctly-wound solid.
//!
//! The pure-Rust kernel consolidation (#1024) deleted the in-tree BSP kernel
//! along with the polygon cap that closed the cut cross-section on the fast
//! plane-clip path (`clip_mesh_with_half_space`), but kept that path for
//! unbounded `IfcHalfSpaceSolid` operands. With no cap, every roof-trim clip
//! came out as an OPEN, inverted shell — negative signed volume and dozens of
//! open boundary edges — instead of a solid.
//!
//! AC20-FZK-Haus `Wand-Ext-OG-2` (#67536) and `Wand-Ext-OG-4` (#75347) are
//! roof-clipped upper walls whose `Body` is
//! `IfcBooleanClippingResult(.DIFFERENCE., extrusion, IfcHalfSpaceSolid)` and
//! that carry NO void — the exact regressed path. Pre-fix each came out as
//! 14 tris / −8.4 m³ / 16 open edges; with the section capped they are
//! 20 tris / +2.06 m³ / 0 open edges.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn fixture(rel: &str) -> Option<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(rel);
    fs::read_to_string(p).ok()
}

fn process_element_only(content: &str, host_id: u32) -> Option<Mesh> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    router.process_element(&entity, &mut decoder).ok()
}

/// Open boundary edges (directed half-edges that do not pair), vertices welded
/// on a 1 mm grid. A watertight solid returns 0.
fn open_boundary_edges(m: &Mesh) -> usize {
    let key = |i: usize| -> (i64, i64, i64) {
        (
            (m.positions[i * 3] as f64 * 1.0e3).round() as i64,
            (m.positions[i * 3 + 1] as f64 * 1.0e3).round() as i64,
            (m.positions[i * 3 + 2] as f64 * 1.0e3).round() as i64,
        )
    };
    let mut vid: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut bal: HashMap<(u32, u32), i32> = HashMap::new();
    for tri in m.indices.chunks_exact(3) {
        let mut id = [0u32; 3];
        for (j, &vi) in tri.iter().enumerate() {
            let k = key(vi as usize);
            let n = vid.len() as u32;
            id[j] = *vid.entry(k).or_insert(n);
        }
        for (x, y) in [(id[0], id[1]), (id[1], id[2]), (id[2], id[0])] {
            let (kk, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(kk).or_insert(0) += s;
        }
    }
    bal.values().filter(|&&v| v != 0).count()
}

fn signed_volume(m: &Mesh) -> f64 {
    let p = |i: usize| {
        [
            m.positions[i * 3] as f64,
            m.positions[i * 3 + 1] as f64,
            m.positions[i * 3 + 2] as f64,
        ]
    };
    let mut vol = 0.0;
    for tri in m.indices.chunks_exact(3) {
        let (a, b, c) = (p(tri[0] as usize), p(tri[1] as usize), p(tri[2] as usize));
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
    }
    vol
}

#[test]
fn roof_clipped_walls_are_watertight_solids() {
    let Some(content) = fixture("tests/models/ara3d/AC20-FZK-Haus.ifc") else {
        eprintln!("AC20-FZK-Haus fixture not staged; skipping");
        return;
    };
    // Wand-Ext-OG-2 (#67536) and Wand-Ext-OG-4 (#75347): roof-clipped, no void —
    // the exact `clip_mesh_with_half_space` path that #1024 left uncapped.
    for id in [67536u32, 75347] {
        let mesh =
            process_element_only(&content, id).unwrap_or_else(|| panic!("#{id} should process"));
        assert!(!mesh.is_empty(), "#{id} produced no geometry");

        let open = open_boundary_edges(&mesh);
        assert_eq!(
            open, 0,
            "#{id}: roof clip must be capped & watertight (16 open edges before the fix)"
        );

        let vol = signed_volume(&mesh);
        assert!(
            vol > 0.5,
            "#{id}: must be a positive-volume solid \
             (was inverted/negative before the fix), got {vol}"
        );
    }
}
