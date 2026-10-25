// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::model::EntityAabb;
use crate::split_geometry::*;
use crate::split_grid::{BoxGrid, cluster_by_proximity};
fn slab(lo: f64, hi: f64) -> EntityAabb {
    EntityAabb { min: [lo, 0.0, 0.0], max: [hi, 1.0, 1.0] }
}
#[test]
fn issue_8042_extent_coverage_requires_each_axis_without_gaps() {
    let whole = slab(0.0, 10.0);
    assert!(extent_coverage(&whole, &[slab(0.0, 4.0), slab(4.0, 10.0)], 0.0));
    assert!(!extent_coverage(&whole, &[slab(0.0, 4.0), slab(4.2, 10.0)], 0.1));
    assert!(extent_coverage(&whole, &[slab(0.0, 4.0), slab(4.2, 10.0)], 0.2));
    assert!(!extent_coverage(&whole, &[], 1.0));
    assert_eq!(box_iou(&whole, &whole), 1.0);
    assert_eq!(box_iou(&slab(0.0, 0.0), &slab(0.0, 0.0)), 0.0);
    assert!(!any_coincident(&[slab(0.0, 4.0), slab(4.0, 10.0)], 0.5));
}
#[test]
fn issue_8042_grid_query_contains_every_true_overlap() {
    let boxes: Vec<_> = (0..100).map(|i| slab(i as f64 * 1.3 - 50.0, i as f64 * 1.3 - 49.0)).collect();
    let grid = BoxGrid::new(&boxes);
    for query in &boxes {
        for pad in [0.0, 0.2, 1.0, 10000.0] {
            let candidates = grid.query(query, pad);
            assert!(candidates.windows(2).all(|w| w[0] < w[1]));
            for (i, b) in boxes.iter().enumerate() {
                if box_within(b, query, pad) { assert!(candidates.contains(&i)); }
            }
        }
    }
}
#[test]
fn issue_8042_clusters_reach_twice_the_larger_padding_across_cells() {
    let boxes = [slab(0.0, 1.0), slab(1.3, 2.3), slab(10.0, 11.0)];
    assert_eq!(cluster_by_proximity(&boxes, &[0.01, 0.2, 0.01]), vec![vec![0, 1], vec![2]]);
    assert_eq!(cluster_by_proximity(&boxes, &[0.01, 0.01, 0.01]), vec![vec![0], vec![1], vec![2]]);
}
