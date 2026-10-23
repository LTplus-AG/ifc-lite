// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::{model::*, key_diff::diff_by_key, split_merge::detect_split_merge, split_types::*};
fn wall(key: &str, lo: f64, hi: f64, volume: Option<f64>) -> EntityFingerprint {
    EntityFingerprint { key: key.into(), ifc_type: "IfcWall".into(), data_hash: key.into(),
        geometry_hash: Some(key.into()), aabb: Some(EntityAabb { min: [lo, 0.0, 0.0], max: [hi, 1.0, 1.0] }),
        volume, components: None, container: None, reference: () }
}
#[test]
fn issue_8042_verified_split_is_additive_and_cross_class() {
    let base = [wall("whole", 0.0, 10.0, Some(10.0))];
    let mut head = [wall("z", 0.0, 4.0, Some(4.0)), wall("a", 4.0, 10.0, Some(6.0))];
    head[0].ifc_type = "IfcBuildingElementPart".into();
    let core = diff_by_key(&base, &head, &KeyDiffOptions::default());
    let claims = detect_split_merge(&core.entries, true, SplitSettings::default(), None).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].confidence, SplitConfidence::Verified);
    assert!(claims[0].cross_class);
    assert_eq!(claims[0].pieces.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["a", "z"]);
    assert_eq!(core.counts.added, 2);
    assert_eq!(core.counts.deleted, 1);
    assert_eq!(core.entries.len(), 3);
    assert!(detect_split_merge(&core.entries, false, SplitSettings::default(), None).is_none());
}
#[test]
fn issue_8042_displaced_match_requires_unique_whole() {
    let head = [wall("p", 20.0, 24.0, Some(4.0)), wall("q", 24.0, 30.0, Some(6.0))];
    let base = [wall("one", 0.0, 10.0, Some(10.0))];
    let core = diff_by_key(&base, &head, &KeyDiffOptions::default());
    let claims = detect_split_merge(&core.entries, true, SplitSettings::default(), None).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].confidence, SplitConfidence::Displaced);
    let base = [wall("one", 0.0, 10.0, Some(10.0)), wall("two", 40.0, 50.0, Some(10.0))];
    let core = diff_by_key(&base, &head, &KeyDiffOptions::default());
    assert!(detect_split_merge(&core.entries, true, SplitSettings::default(), None).unwrap().is_empty());
}
#[test]
fn issue_8042_three_equal_claims_all_abstain() {
    let base = [wall("a", 0.0, 10.0, Some(10.0)), wall("b", 0.0, 10.0, Some(10.0)), wall("c", 0.0, 10.0, Some(10.0))];
    let head = [wall("p", 0.0, 4.0, Some(4.0)), wall("q", 4.0, 10.0, Some(6.0))];
    let core = diff_by_key(&base, &head, &KeyDiffOptions::default());
    assert!(detect_split_merge(&core.entries, true, SplitSettings::default(), None).unwrap().is_empty());
}
