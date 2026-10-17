// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Merging a file with itself must write no duplicate rooted GlobalId, and the
//! duplicate check (the one `examples/merge_ifc.rs` prints) must see what the
//! merge saw. Whether a collision is SEEN may never depend on GlobalId
//! validity: real files carry ids whose first character is outside `0..=3`
//! (#7777 review: test.ifc, test-colors.ifc and BIMcollab_ebkp went from 0 to 3
//! duplicates when the merge scan became strict).

use ifc_lite_export::rooted_type::is_rooted_type;
use ifc_lite_export::{export_merged_models, MergedModel, MergedOptions};
use std::collections::HashMap;

/// The leading GlobalId of a rooted line, read INDEPENDENTLY of the crate's
/// GlobalId readers (length + alphabet only, inline): a counter that shares the
/// reader under test is blind to the very defect it must catch.
fn rooted_guid(line: &str) -> Option<&str> {
    let after_eq = &line[line.find('=')? + 1..];
    let open = after_eq.find('(')?;
    if !is_rooted_type(&after_eq[..open].trim().to_ascii_uppercase()) {
        return None;
    }
    let body = after_eq[open + 1..].trim_start().strip_prefix('\'')?;
    let tok = &body[..body.find('\'')?];
    let shaped = tok.len() == 22 && tok.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$');
    shaped.then_some(tok)
}

fn rooted_counts(step: &str) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for line in step.lines().filter(|l| l.starts_with('#')) {
        if let Some(g) = rooted_guid(line) {
            *m.entry(g.to_string()).or_default() += 1;
        }
    }
    m
}

fn self_merge_has_no_duplicates(rel: &str) {
    let Some(src) = ifc_lite_testkit::fixture_bytes(rel) else { return };
    let models: Vec<MergedModel> = ["a", "b"]
        .iter()
        .map(|id| MergedModel { content: &src, id: id.to_string(), included: None })
        .collect();
    let (merged, _) = export_merged_models(&models, &MergedOptions::default());
    let dups: Vec<_> = rooted_counts(&merged).into_iter().filter(|(_, n)| *n > 1).collect();
    assert!(dups.is_empty(), "{rel}: {} duplicate rooted GlobalIds, e.g. {:?}", dups.len(), &dups[..dups.len().min(3)]);

    // The check agrees with the merge: a single copy and the self-merge carry the
    // same set of rooted ids (relationships are re-stamped, so only compare ids
    // the single copy has).
    let (single, _) = export_merged_models(&models[..1], &MergedOptions::default());
    let once = rooted_counts(&single);
    let twice = rooted_counts(&merged);
    for g in once.keys() {
        assert!(twice.contains_key(g), "{rel}: {g} lost by the self-merge");
    }
}

#[test]
fn test_ifc_self_merge_has_no_duplicate_globalids() {
    self_merge_has_no_duplicates("various/test.ifc");
}

#[test]
fn test_colors_ifc_self_merge_has_no_duplicate_globalids() {
    self_merge_has_no_duplicates("various/test-colors.ifc");
}

#[test]
fn bimcollab_ebkp_self_merge_has_no_duplicate_globalids() {
    self_merge_has_no_duplicates("various/02_BIMcollab_Example_STR_random_C_ebkp.ifc");
}
