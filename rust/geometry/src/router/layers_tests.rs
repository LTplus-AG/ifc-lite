// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn li(material: u32, thickness: f64) -> LayerInfo {
    LayerInfo { material_id: material, thickness }
}

#[test]
fn thin_middle_layer_folded_into_thicker_neighbour() {
    // 100 mm core, 1 mm vapour barrier, 50 mm insulation — unit_scale
    // = 0.001 so values are in meters after scaling.
    let layers = vec![li(1, 100.0), li(2, 1.0), li(3, 50.0)];
    let merged = merge_thin_layers(&layers, 0.001);
    assert_eq!(merged.len(), 2, "3-layer stack with a sub-mm middle should collapse to 2 slabs");
    // First slab absorbed the 1 mm barrier; thicker contributor keeps its material.
    assert_eq!(merged[0].material_id, 1);
    assert!((merged[0].thickness_m - 0.101).abs() < 1e-9);
    assert_eq!(merged[1].material_id, 3);
    assert!((merged[1].thickness_m - 0.050).abs() < 1e-9);
}

#[test]
fn all_thick_layers_stay_separate() {
    let layers = vec![li(1, 50.0), li(2, 80.0), li(3, 30.0)];
    let merged = merge_thin_layers(&layers, 0.001);
    assert_eq!(merged.len(), 3);
    assert_eq!(merged[0].material_id, 1);
    assert_eq!(merged[1].material_id, 2);
    assert_eq!(merged[2].material_id, 3);
}

#[test]
fn trailing_thin_layer_folds_into_previous_slab() {
    let layers = vec![li(1, 50.0), li(2, 80.0), li(3, 1.0)];
    let merged = merge_thin_layers(&layers, 0.001);
    assert_eq!(merged.len(), 2, "sub-mm trailing layer merges into the previous slab");
    assert_eq!(merged[1].material_id, 2);
    assert!((merged[1].thickness_m - 0.081).abs() < 1e-9);
}

#[test]
fn leading_thin_layer_folds_into_next_slab() {
    let layers = vec![li(1, 1.0), li(2, 80.0), li(3, 50.0)];
    let merged = merge_thin_layers(&layers, 0.001);
    assert_eq!(merged.len(), 2);
    // First emitted slab is dominated by layer 2 (thicker than the 1 mm lead-in).
    assert_eq!(merged[0].material_id, 2);
    assert!((merged[0].thickness_m - 0.081).abs() < 1e-9);
    assert_eq!(merged[1].material_id, 3);
}
