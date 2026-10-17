// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Allocation or work sized by untrusted input in `ifc-lite-geometry` (#7675).

use ifc_lite_geometry::rect_fast::{subtract_rect_openings, RectFastStats};
use ifc_lite_geometry::{LayerAxis, LayerBuildup, LayerInfo, MaterialLayerIndex, Mesh};

/// Axis-aligned closed box, 6 quads, outward winding.
fn box_mesh(min: [f32; 3], max: [f32; 3]) -> Mesh {
    let c = |i: usize| {
        [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ]
    };
    let faces = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]];
    let mut m = Mesh::new();
    for f in faces {
        let base = (m.positions.len() / 3) as u32;
        for corner in f {
            m.positions.extend_from_slice(&c(corner));
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    m.normals = vec![0.0; m.positions.len()];
    m
}

/// PROC-16: `MAX_FAST_OPENINGS` (128) capped the opening count, but the
/// cellular decomposition's work is cells x openings, and 128 openings
/// staggered on all three axes give 257^3 ≈ 1.7e7 cells, each re-tested
/// against every opening for itself and six neighbours (~1.5e10 comparisons)
/// in a path that only exists to be fast. It must defer to the exact kernel.
#[test]
fn proc_16_rect_fast_defers_when_the_cell_grid_is_too_large() {
    let host = box_mesh([0.0; 3], [10.0; 3]);
    let openings: Vec<([f64; 3], [f64; 3])> = (0..128)
        .map(|k| {
            let lo = 0.01 + k as f64 * 0.07;
            ([lo; 3], [lo + 0.03; 3])
        })
        .collect();
    let mut stats = RectFastStats::default();
    let cut = subtract_rect_openings(&host, &openings, &mut stats);
    assert!(cut.is_none(), "a 1.7e7-cell grid ran the fast path");
    assert_eq!(stats.defer_too_many_openings, 1, "{stats:?}");
}

/// The cap is on the grid, not on real walls: a wall with a row of windows
/// still takes the fast path.
#[test]
fn proc_16_rect_fast_still_fires_on_a_wall_with_a_row_of_windows() {
    let host = box_mesh([0.0, 0.0, 0.0], [40.0, 0.3, 3.0]);
    let openings: Vec<([f64; 3], [f64; 3])> =
        (0..20).map(|k| ([0.5 + 2.0 * k as f64, -1.0, 1.0], [1.5 + 2.0 * k as f64, 1.3, 2.2])).collect();
    let mut stats = RectFastStats::default();
    assert!(subtract_rect_openings(&host, &openings, &mut stats).is_some(), "{stats:?}");
    assert_eq!(stats.fired, 1);
}

fn sliceable(material_id: u32, thickness: f64) -> LayerBuildup {
    LayerBuildup::Sliceable {
        layers: vec![LayerInfo { material_id, thickness }],
        axis: LayerAxis::Axis2,
        direction_sense: 1.0,
        offset_from_reference_line: 0.0,
    }
}

/// PROC-AL-25: `from_flat` decodes the pre-pass's SoA wire arrays. A
/// `NotSliceable` record (axis 0) owns no layers, but its count still moved
/// the cursor, unchecked, so every later record read another record's layers
/// or was silently dropped; on wasm32 `cursor + count` could also wrap past
/// the bounds check into a `Vec::with_capacity` of ~4G layers. A malformed
/// buffer is refused as a whole, so the caller keeps building its own index.
#[test]
fn proc_al_25_from_flat_refuses_layers_on_a_not_sliceable_record() {
    let decoded = MaterialLayerIndex::from_flat(&[1, 2], &[0, 2], &[1, 1], &[0.0, 1.0], &[0.0, 0.0], &[10, 11], &[0.1, 0.2]);
    // The layer arrays back every count, so only the axis-0 rule can refuse.
    assert!(decoded.is_none(), "axis-0 record with a layer count was accepted: {decoded:?}");
}

#[test]
fn proc_al_25_from_flat_refuses_counts_past_the_layer_arrays() {
    for counts in [[1, 2], [1, u32::MAX], [u32::MAX, u32::MAX]] {
        let decoded =
            MaterialLayerIndex::from_flat(&[1, 2], &[2, 2], &counts, &[1.0, 1.0], &[0.0, 0.0], &[10, 11], &[0.1, 0.2]);
        assert!(decoded.is_none(), "counts {counts:?} over two layers were accepted");
    }
}

#[test]
fn proc_al_25_from_flat_still_round_trips_a_well_formed_index() {
    let decoded = MaterialLayerIndex::from_flat(&[1, 2], &[0, 2], &[0, 1], &[0.0, 1.0], &[0.0, 0.0], &[10], &[0.1])
        .expect("well-formed");
    assert_eq!(decoded.get(1), Some(&LayerBuildup::NotSliceable));
    assert_eq!(decoded.get(2), Some(&sliceable(10, 0.1)));
}
