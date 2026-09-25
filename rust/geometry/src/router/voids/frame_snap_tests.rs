// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn clusters_merge_within_tolerance_and_keep_distinct_values() {
    let c = AxisClusters::build(vec![0.040001, -0.04, 0.039999, -0.040002, 0.5], 1e-5);
    assert_eq!(c.snap(0.040001), c.snap(0.039999));
    assert_eq!(c.snap(-0.04), c.snap(-0.040002));
    assert_ne!(c.snap(0.04), c.snap(-0.04));
    assert_eq!(c.snap(0.5), 0.5);
    // A value outside every run is left alone.
    assert_eq!(c.snap(0.25), 0.25);
}

#[test]
fn a_chain_of_distinct_values_is_not_collapsed() {
    // Values 1e-5 apart, 20 of them: every gap is within tolerance, but the
    // run spans ~13 tolerances, so it is dense geometry, not rounding noise.
    let values: Vec<f64> = (0..20).map(|i| i as f64 * 1e-5).collect();
    let c = AxisClusters::build(values.clone(), 1.5e-5);
    for v in values {
        assert_eq!(c.snap(v), v);
    }
}

#[test]
fn tolerance_is_capped_far_from_the_origin() {
    // 100 km out the f32 quantum is centimetres; the snap must not follow it.
    assert!(frame_snap_tolerance(100_000.0) <= 1e-4);
    assert!(frame_snap_tolerance(60.0) < 1e-4);
}
