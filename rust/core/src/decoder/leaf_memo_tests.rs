// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{EntityDecoder, EntityIndex, Error};
use rustc_hash::FxHashMap;
use std::sync::Arc;

// #7779: count real attempts to enter the unchanged strict raw parser, not
// inferred hits or a mock result. This is work accounting, not a timing claim.
#[test]
fn issue_7779_raw_leaf_memo_reuses_one_success_and_keeps_kind_separate() {
    let content = "#1=IFCCARTESIANPOINT((-0.,2.));\n#2=IFCCARTESIANPOINT((3.,4.));";
    let mut d = EntityDecoder::new(content);
    for _ in 0..2 {
        assert_eq!(d.point3(1).unwrap().map(f64::to_bits), [-0.0_f64, 2.0, 0.0].map(f64::to_bits));
    }
    assert_eq!(d.raw_leaf_parse_attempts, 1);
    assert_eq!(d.point3(2).unwrap(), [3.0, 4.0, 0.0]);
    assert_eq!(d.raw_leaf_parse_attempts, 2);
    assert!(matches!(d.direction3(2), Err(Error::MalformedRecord(2))));
    assert_eq!(d.raw_leaf_parse_attempts, 3);
    assert_eq!(d.point3(2).unwrap(), [3.0, 4.0, 0.0]);
    assert_eq!(d.raw_leaf_parse_attempts, 3, "a refusal never replaces the last success");
    assert_eq!(d.point3(1).unwrap()[0].to_bits(), (-0.0_f64).to_bits());
    assert_eq!(d.raw_leaf_parse_attempts, 4, "only one successful entry is retained");
}

#[test]
fn issue_7779_raw_leaf_memo_clear_and_drain_force_a_real_reparse() {
    for action in 0..3 {
        let mut d = EntityDecoder::new("#1=IFCCARTESIANPOINT((1.,2.,3.));");
        assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
        assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
        assert_eq!(d.raw_leaf_parse_attempts, 1);
        match action {
            0 => d.clear_entity_cache(),
            1 => d.clear_cache(),
            _ => { drop(d.drain_cache()); }
        }
        assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
        assert_eq!(d.raw_leaf_parse_attempts, 2);
        assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
        assert_eq!(d.raw_leaf_parse_attempts, 2);
    }
}

#[test]
fn issue_7779_raw_leaf_memo_is_independent_of_type_agnostic_point_cache() {
    let mut d = EntityDecoder::new("#1=IFCCARTESIANPOINT((1.,2.,3.));");
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
    d.set_point_cache(FxHashMap::from_iter([(1, (90.0, 80.0, 70.0))]));
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
    d.clear_point_cache();
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
    drop(d.take_point_cache());
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
    assert_eq!(d.raw_leaf_parse_attempts, 4, "configuration changes force raw reparsing");
}

#[test]
fn issue_7779_raw_leaf_memo_keys_requested_id_even_for_aliased_index_spans() {
    let content = "#1=IFCCARTESIANPOINT((1.,2.,3.));";
    let mut index = EntityIndex::default();
    index.insert(1, (0, content.len()));
    index.insert(2, (0, content.len()));
    let mut d = EntityDecoder::with_index(content, index);
    for id in [1, 2, 2, 1] {
        assert_eq!(d.point3(id).unwrap(), [1.0, 2.0, 3.0]);
    }
    assert_eq!(d.raw_leaf_parse_attempts, 3);
}

#[test]
fn issue_7779_raw_leaf_memo_never_remembers_a_fallback_overlay() {
    let mut d = EntityDecoder::new("#1=IFCCARTESIANPOINT((IFCREAL(1.),2.,3.));");
    for (record, expected) in [
        ("#1=IFCCARTESIANPOINT((10.,20.,30.));", [10.0, 20.0, 30.0]),
        ("#1=IFCCARTESIANPOINT((40.,50.,60.));", [40.0, 50.0, 60.0]),
    ] {
        let mut donor = EntityDecoder::new(record);
        let entity = donor.decode_by_id(1).unwrap();
        d.inject_shared_cache(&FxHashMap::from_iter([(1, Arc::new(entity))]));
        assert_eq!(d.point3(1).unwrap(), expected);
    }
    assert_eq!(d.raw_leaf_parse_attempts, 2);
    d.clear_entity_cache();
    assert!(matches!(d.point3(1), Err(Error::MalformedRecord(1))));
    assert_eq!(d.raw_leaf_parse_attempts, 3);
    assert_eq!(d.refused_record_ids(), vec![1]);
}

#[test]
fn issue_7779_raw_leaf_storage_preserves_decoder_auto_trait_contracts() {
    fn require<T: Send + Sync + std::panic::RefUnwindSafe>() {}
    require::<EntityDecoder<'static>>();
}

// #7917 recovery: factory source authority must not survive compatibility
// index replacement, even with a warm memo and the same requested IFC id.
#[test]
fn issue_7779_source_index_replacement_revokes_warm_memo() {
    let first = "#1=IFCCARTESIANPOINT((1.,2.));\n";
    let last = "#1=IFCCARTESIANPOINT((7.,8.));";
    let source = crate::SourceBundle::new(format!("{first}{last}").into_bytes());
    let mut d = source.decoder();
    assert!(source.owns_decoder(&d));
    for _ in 0..2 {
        assert_eq!(d.point3(1).unwrap(), [7.0, 8.0, 0.0]);
    }
    assert_eq!(d.raw_leaf_parse_attempts, 1);
    let mut earlier = EntityIndex::default();
    earlier.insert(1, (0, first.len()));
    d.set_entity_index(Arc::new(earlier));
    assert!(!source.owns_decoder(&d));
    assert!(d.raw_leaf_memo.is_none(), "replacement drops the warm witness");
    for _ in 0..2 {
        assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 0.0]);
    }
    assert_eq!(d.raw_leaf_parse_attempts, 2);
    source.install_compatibility_index(&mut d);
    assert!(d.raw_leaf_memo.is_none());
    assert_eq!(d.point3(1).unwrap(), [7.0, 8.0, 0.0]);
    assert_eq!(d.raw_leaf_parse_attempts, 3);
    assert!(!source.owns_decoder(&d), "raw parsing cannot regrant factory authority");
    assert_eq!(d.refused_records(), 0);
}

// #7917: an unchanged selected span still needs the current canonical
// configuration generation. Values remain raw after a trusted overlay import.
#[test]
fn issue_7779_configuration_change_reparses_same_raw_span() {
    let source = crate::SourceBundle::new(b"#1=IFCCARTESIANPOINT((1.,2.));".to_vec());
    let mut d = source.decoder();
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 0.0]);
    let original_identity = d.execution_identity();
    d = d.with_strict_reals();
    assert_ne!(d.execution_identity(), original_identity);
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 0.0]);
    assert_eq!(d.raw_leaf_parse_attempts, 2);
    let mut overlay = EntityDecoder::new("#1=IFCCARTESIANPOINT((9.,8.));");
    let cache = overlay.decode_by_id(1).unwrap();
    d.inject_shared_cache(&FxHashMap::from_iter([(1, Arc::new(cache))]));
    assert!(!source.owns_decoder(&d));
    assert!(d.raw_leaf_memo.is_none(), "authority revocation drops the witness");
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 0.0]);
    assert_eq!(d.raw_leaf_parse_attempts, 3);
    assert_eq!(d.refused_records(), 0);
}
