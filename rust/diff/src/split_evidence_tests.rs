// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn issue_8042_missing_volume_can_refute_but_cannot_confirm() {
    let partial = judge_volumes(Some(10.0), &[Some(11.0), None], 0.03);
    assert_eq!(partial.kind, VolumeKind::Refuted);
    assert!(!partial.complete);
    assert_eq!(partial.pieces_volume, Some(11.0));
    let incomplete = judge_volumes(Some(10.0), &[Some(10.0), None], 0.03);
    assert_eq!(incomplete.kind, VolumeKind::Unknown);
    assert_eq!(incomplete.pieces_volume, None);
    assert_eq!(incomplete.residual, None);
    let complete = judge_volumes(Some(10.0), &[Some(4.0), Some(6.0)], 0.03);
    assert_eq!(complete.kind, VolumeKind::Confirmed);
    assert!(complete.complete);
    assert_eq!(complete.residual, Some(0.0));
}

#[test]
fn issue_8042_unusable_whole_abstains_and_undershoot_refutes() {
    for whole in [None, Some(0.0), Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
        let result = judge_volumes(whole, &[Some(4.0), Some(6.0)], 0.03);
        assert_eq!(result.kind, VolumeKind::Unknown);
        assert_eq!(result.whole_volume, None);
        assert!(!result.complete);
    }
    assert_eq!(judge_volumes(Some(10.0), &[Some(4.0), Some(4.0)], 0.03).kind, VolumeKind::Refuted);
}

#[test]
fn issue_8042_interloper_requires_unique_explanation_and_two_remaining_pieces() {
    assert_eq!(find_single_interloper(10.0, &[4.0, 6.0, 2.0], 0.03), Some(2));
    assert_eq!(find_single_interloper(10.0, &[5.0, 5.0, 5.0], 0.03), None);
    assert_eq!(find_single_interloper(10.0, &[10.0, 2.0], 0.03), None);
    assert_eq!(find_single_interloper(10.0, &[2.0, 2.0, 2.0], 0.03), None);
}
