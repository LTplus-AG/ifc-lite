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
