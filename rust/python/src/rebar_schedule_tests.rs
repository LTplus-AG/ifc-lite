// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn issue_6305_preflight_comparisons_cannot_become_null() {
    let ifc = include_bytes!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
    let limits = RebarPreflightLimits::new(0.0, 0.0, None).unwrap();
    let mut schedule = build_rebar_schedule_with_preflight(
        ifc, None, &SweptDiskCheckOptions::default(), &limits,
    ).unwrap();
    assert!(validate_finite(&schedule).is_ok());

    schedule.rows.get_mut(&125).unwrap().sweeps[0]
        .preflight.as_mut().unwrap().comparisons.as_mut().unwrap()[0].measured_m = f64::INFINITY;
    assert_eq!(validate_finite(&schedule).unwrap_err(),
        "rebar #125 sweep 0 preflight.comparisons[0].measured_m is non-finite");

    let comparison = &mut schedule.rows.get_mut(&125).unwrap().sweeps[0]
        .preflight.as_mut().unwrap().comparisons.as_mut().unwrap()[0];
    comparison.measured_m = 0.0;
    comparison.limit_m = f64::NAN;
    assert_eq!(validate_finite(&schedule).unwrap_err(),
        "rebar #125 sweep 0 preflight.comparisons[0].limit_m is non-finite");
}
