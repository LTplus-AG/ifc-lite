// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::content_match::apply_content_matching;
use crate::content_types::*;
use crate::geometry_compare::*;
use crate::key_diff::diff_by_key;
use crate::model::*;
use crate::mutual_nearest::mutual_nearest_pairs;

fn entity(key: &str, data: &str, geometry: &str, x: f64) -> EntityFingerprint {
    EntityFingerprint {
        key: key.into(), ifc_type: "IfcWall".into(), data_hash: data.into(), geometry_hash: Some(geometry.into()),
        aabb: Some(EntityAabb { min: [x, 0.0, 0.0], max: [x + 1.0, 1.0, 1.0] }),
        volume: None, components: None, container: None, reference: (),
    }
}
#[test]
fn geometry_only_precedes_weaker_data_residue_issue_8042() {
    let base = vec![entity("a", "data", "g1", 0.0), entity("b", "data", "g2", 3.0)];
    let head = vec![entity("c", "new-data", "g1", 0.0), entity("d", "data", "g3", 2.5)];
    let result = apply_content_matching(diff_by_key(&base, &head, &KeyDiffOptions::default()), GeometryTolerances::default());
    assert!(result.core.entries.is_empty());
    assert_eq!(result.core.counts, DiffCounts::default());
    assert_eq!(result.content_matches.len(), 2);
    let first = &result.content_matches[0];
    assert_eq!(first.kind, ContentMatchKind::Respecified);
    assert_eq!(first.base[0].key, "a");
    assert_eq!(first.head[0].key, "c");
    assert_eq!(first.geometry_hash.as_ref().and_then(crate::JsString::as_str), Some("g1"));
    let second = &result.content_matches[1];
    assert_eq!(second.kind, ContentMatchKind::Moved);
    assert_eq!(second.base[0].key, "b");
    assert_eq!(second.head[0].key, "d");
    assert_eq!(second.distance, Some(0.5));
}
#[test]
fn unresolved_groups_do_not_remove_entries_issue_8042() {
    let base = vec![entity("a", "data", "g", 0.0)];
    let head = vec![entity("b", "data", "g", 0.0), entity("c", "data", "g", 0.0)];
    let result = apply_content_matching(diff_by_key(&base, &head, &KeyDiffOptions::default()), GeometryTolerances::default());
    assert_eq!(result.core.counts.added, 2);
    assert_eq!(result.core.counts.deleted, 1);
    assert_eq!(result.core.entries.len(), 3);
    assert_eq!(result.content_matches[0].kind, ContentMatchKind::Duplicated);
}
#[test]
fn nearest_veto_and_exact_ties_abstain_issue_8042() {
    let base = [[0.0, 0.0, 0.0], [5.0, 0.0, 0.0]];
    let head = [[1.0, 0.0, 0.0], [4.0, 0.0, 0.0]];
    let pairs = mutual_nearest_pairs(&base, &head, 100.0, |b, h| !(b == 0 && h == 0), 1.0);
    assert_eq!(pairs.len(), 1);
    assert_eq!((pairs[0].base, pairs[0].head, pairs[0].distance), (1, 1, 1.0));
    assert!(mutual_nearest_pairs(&[[0.0; 3]], &[[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]], 100.0, |_, _| true, 1.0).is_empty());
}
#[test]
fn unchanged_bounds_with_different_hash_mean_reshape_issue_8042() {
    let bounds = EntityAabb { min: [0.0; 3], max: [1.0; 3] };
    assert_eq!(classify_geometry_change(Some(&bounds), Some(&bounds), GeometryTolerances::default()),
        GeometryChange { kind: GeometryChangeKind::Reshaped, distance: Some(0.0) });
    assert_eq!(classify_geometry_change(None, Some(&bounds), GeometryTolerances::default()).distance, None);
    let tolerances = GeometryTolerances::resolve(Some(f64::NAN), Some(-1.0), Some(0.0));
    assert_eq!(tolerances.move_tolerance, 2e-3);
    assert_eq!(tolerances.reshape_tolerance, 1e-3);
    assert_eq!(tolerances.max_move_distance, 0.0);
}
