// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::IfcAPI;

#[test]
fn issue_3989_borrowed_rust_api_preserves_caller_ownership_and_duplicate_semantics() {
    // A Rust consumer of the published pre-change signature must still compile.
    let install: fn(&IfcAPI, &[u32], &[u32], &[u32]) = IfcAPI::set_entity_index;
    let api = IfcAPI::new();
    let mut ids = [7, 3, 7];
    let mut starts = [10, 20, 30];
    let mut lengths = [1, 2, 3];
    install(&api, &ids, &starts, &lengths);
    // Borrowed inputs remain caller-owned. Reusing them cannot corrupt the
    // installed index, and stable last-occurrence-wins behavior is unchanged.
    ids.fill(99);
    starts.fill(99);
    lengths.fill(99);
    let slot = api.cached_entity_index.lock().unwrap();
    let index = slot.as_ref().unwrap();
    assert_eq!(index.lookup(7), Some((30, 33)));
    assert_eq!(index.lookup(3), Some((20, 22)));
    assert_eq!(index.lookup(99), None);
}

#[test]
fn issue_3989_owned_binding_adopts_sorted_columns_without_reallocation() {
    let api = IfcAPI::new();
    let ids = vec![3, 7];
    let starts = vec![20, 30];
    let lengths = vec![2, 3];
    let pointers = (ids.as_ptr(), starts.as_ptr(), lengths.as_ptr());
    api.set_entity_index_owned_binding(ids, starts, lengths);
    let slot = api.cached_entity_index.lock().unwrap();
    let index = slot.as_ref().unwrap();
    assert_eq!((index.ids().as_ptr(), index.starts().as_ptr(), index.lengths().as_ptr()), pointers);
    assert_eq!(index.lookup(7), Some((30, 33)));
}

#[test]
fn issue_3989_both_adapters_ignore_invalid_input_and_reset_content_caches_on_replacement() {
    let api = IfcAPI::new();
    api.set_entity_index(&[1], &[10], &[2]);
    api.set_referenced_repmaps(&[1]);
    // Neither empty nor mismatched columns constitute a model replacement.
    api.set_entity_index(&[2], &[], &[3]);
    api.set_entity_index_owned_binding(Vec::new(), Vec::new(), Vec::new());
    assert_eq!(api.cached_entity_index.lock().unwrap().as_ref().unwrap().lookup(1), Some((10, 12)));
    assert!(api.cached_referenced_repmaps.lock().unwrap().as_ref().unwrap().contains(&1));
    // A new source must not inherit old representation-map suppression.
    api.set_entity_index_owned_binding(vec![2], vec![30], vec![4]);
    assert!(api.cached_referenced_repmaps.lock().unwrap().is_none());
    api.set_referenced_repmaps(&[2]);
    api.set_entity_index(&[3], &[40], &[5]);
    assert!(api.cached_referenced_repmaps.lock().unwrap().is_none());
    assert_eq!(api.cached_entity_index.lock().unwrap().as_ref().unwrap().lookup(3), Some((40, 45)));
}
