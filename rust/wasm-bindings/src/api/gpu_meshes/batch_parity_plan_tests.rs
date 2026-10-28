// SPDX-License-Identifier: MPL-2.0
//! #7782: ordered planned identities and the available unit-refusal contract.
use super::{
    compare::{Axis, Drift},
    PlannedJob,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn compare(fixture: &'static str, native: &[PlannedJob], browser: &[PlannedJob], drifts: &mut Vec<Drift>) {
    // Global product scheduling differs; map expansion order within a product must not.
    let group = |jobs: &[PlannedJob]| {
        let mut result: BTreeMap<u32, Vec<PlannedJob>> = BTreeMap::new();
        for &job in jobs {
            result.entry(job.0).or_default().push(job);
        }
        result
    };
    let (n, b) = (group(native), group(browser));
    for id in n.keys().chain(b.keys()).copied().collect::<BTreeSet<_>>() {
        let left = n.get(&id).cloned().unwrap_or_default();
        let right = b.get(&id).cloned().unwrap_or_default();
        if left != right {
            drifts.push(Drift {
                fixture,
                axis: Axis::PlannedJobs,
                element: Some(id),
                detail: format!("native {left:?} vs browser {right:?}"),
            });
        }
    }
}

pub(super) fn units(
    fixture: &'static str,
    native: Option<u32>,
    browser: &ifc_lite_processing::stream_meta::StreamMeta,
    drifts: &mut Vec<Drift>,
) {
    // This observes the source of unitRefused, not JS serialization. The once
    // path exposes no per-element refusal reason/code payload; do not invent one.
    let expected = (native, native.is_some(), native.is_some());
    let actual = (
        browser.length_unit_refused,
        browser.length_unit_refused.is_some(),
        super::super::super::prepass_sharded::stream_meta_unit_scale(browser).is_nan(),
    );
    if expected != actual {
        drifts.push(Drift {
            fixture,
            axis: Axis::UnitRefusal,
            element: None,
            detail: format!("(record, unitRefused, unitScaleNaN): native {expected:?} vs browser {actual:?}"),
        });
    }
}

#[test]
fn map_identity_class_and_order_are_observed_7782() {
    let original = [(42, Some(10), 1), (42, Some(20), 1)];
    for changed in [
        [(42, Some(11), 1), original[1]],
        [(42, Some(10), 2), original[1]],
        [original[1], original[0]],
    ] {
        let mut drifts = Vec::new();
        compare("control", &original, &changed, &mut drifts);
        assert_eq!(drifts.len(), 1);
        assert_eq!(drifts[0].axis, Axis::PlannedJobs);
    }
}
