// SPDX-License-Identifier: MPL-2.0
use crate::{EntityDecoder, EntityScanner, GridAxisIndex, SourceBundle};
use rustc_hash::FxHashMap;
use std::sync::Arc;

#[test]
fn foreign_raw_decoded_cache_cannot_acquire_or_retain_bundle_authority() {
    let source = SourceBundle::new(b"DATA;#1=IFCWALL();".to_vec());
    let mut foreign = EntityDecoder::new(b"DATA;#1=IFCBEAM();");
    foreign.decode_by_id(1).unwrap();
    let cache = foreign.drain_cache();
    let mut candidate = EntityDecoder::new(source.bytes());
    candidate.inject_shared_cache(&cache);
    assert!(!source.bind_decoder(&mut candidate));
    let mut bound = source.decoder();
    bound.inject_shared_cache(&cache);
    assert!(!source.owns_decoder(&bound));
    assert_eq!(
        bound.decode_by_id(1).unwrap().ifc_type.as_str(),
        "IFCBEAM",
        "legacy trusted-input behavior remains usable, without authentication"
    );
    let inputs = bound.trusted_inputs().unwrap();
    assert!(inputs.matches(&bound));
    bound.inject_shared_cache(&cache);
    assert!(
        !inputs.matches(&bound),
        "later imports create a new trusted revision"
    );
}

#[test]
fn direct_duplicate_reads_cannot_override_canonical_id_cache() {
    let source = SourceBundle::new(b"DATA;#1=IFCWALL();#1=IFCBEAM();".to_vec());
    let (_, _, start, end) = EntityScanner::new(source.bytes()).next_entity().unwrap();
    let mut borrowed = EntityDecoder::new(source.bytes());
    borrowed.decode_at(start, end).unwrap();
    assert!(!source.bind_decoder(&mut borrowed));
    // A1 source review of 3e23a20bb8: the known-ID fast path is cache-first;
    // only decode_at promises the supplied earlier span after canonical warmup.
    for known_id in [false, true] {
        for warm in [false, true] {
            let mut bound = source.decoder();
            if warm {
                assert_eq!(bound.decode_by_id(1).unwrap().ifc_type.as_str(), "IFCBEAM");
            }
            let earlier = if known_id {
                bound.decode_at_with_id(1, start, end).unwrap()
            } else {
                bound.decode_at(start, end).unwrap()
            };
            assert_eq!(
                earlier.ifc_type.as_str(),
                if known_id && warm {
                    "IFCBEAM"
                } else {
                    "IFCWALL"
                }
            );
            assert_eq!(
                bound.cache_size(),
                usize::from(warm),
                "cold earlier-duplicate reads must not seed the canonical cache"
            );
            assert_eq!(bound.decode_by_id(1).unwrap().ifc_type.as_str(), "IFCBEAM");
            assert_eq!(
                bound.decode_at(start, end).unwrap().ifc_type.as_str(),
                "IFCWALL"
            );
            assert_eq!(
                bound
                    .decode_at_with_id(1, start, end)
                    .unwrap()
                    .ifc_type
                    .as_str(),
                "IFCBEAM"
            );
            assert!(source.owns_decoder(&bound));
        }
    }
}

#[test]
fn prewarmed_decoded_cache_has_checked_same_bundle_transfer() {
    let source = SourceBundle::new(b"DATA;#1=IFCWALL();".to_vec());
    let foreign = SourceBundle::new(b"DATA;#1=IFCBEAM();".to_vec());
    let mut warm = source.decoder();
    warm.decode_by_id(1).unwrap();
    let cache = warm.drain_source_cache();
    let mut fresh = source.decoder();
    assert!(fresh.inject_source_cache(&cache));
    assert_eq!(fresh.cache_size(), 1);
    assert!(source.owns_decoder(&fresh));
    assert_eq!(fresh.decode_by_id(1).unwrap().ifc_type.as_str(), "IFCWALL");
    let mut wrong = foreign.decoder();
    assert!(!wrong.inject_source_cache(&cache));
    assert_eq!(wrong.decode_by_id(1).unwrap().ifc_type.as_str(), "IFCBEAM");
}

#[test]
fn point_and_placement_cache_transfers_reject_foreign_and_reuse_same_source() {
    let source = SourceBundle::new(
        b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));#2=IFCPOLYLOOP((#1,#1,#1));".to_vec(),
    );
    let foreign = SourceBundle::new(
        b"DATA;#1=IFCCARTESIANPOINT((9.,8.,7.));#2=IFCPOLYLOOP((#1,#1,#1));".to_vec(),
    );
    let mut warm = source.decoder();
    assert_eq!(
        warm.get_polyloop_coords_cached(2).unwrap(),
        vec![(1., 2., 3.); 3]
    );
    // Placement memo entries are written under the existing trusted canonical
    // transform contract; the transfer must not assert a foreign source.
    warm.cache_placement_transform(3, [4.; 16]);
    let mut same = source.decoder();
    assert!(same.set_source_point_cache(warm.take_source_point_cache()));
    assert!(same.set_source_placement_cache(warm.take_source_placement_cache()));
    assert_eq!(
        same.get_polyloop_coords_cached(2).unwrap(),
        vec![(1., 2., 3.); 3]
    );
    assert_eq!(same.point_cache_stats(), (3, 0));
    assert_eq!(same.get_placement_transform_cached(3), Some([4.; 16]));
    assert!(source.owns_decoder(&same));
    let mut wrong = foreign.decoder();
    assert!(!wrong.set_source_point_cache(same.take_source_point_cache()));
    assert!(!wrong.set_source_placement_cache(same.take_source_placement_cache()));
    assert_eq!(
        wrong.get_polyloop_coords_cached(2).unwrap(),
        vec![(9., 8., 7.); 3]
    );
    assert_eq!(wrong.get_placement_transform_cached(3), None);
    assert!(foreign.owns_decoder(&wrong));
}

#[test]
fn raw_point_placement_and_grid_imports_revoke_authority_even_when_empty() {
    let source = SourceBundle::new(b"DATA;#1=IFCWALL();".to_vec());
    let mut points = source.decoder();
    points.set_point_cache(FxHashMap::default());
    assert!(!source.owns_decoder(&points));
    let mut placements = source.decoder();
    placements.set_placement_transform_cache(FxHashMap::default());
    assert!(!source.owns_decoder(&placements));
    let mut grids = source.decoder();
    grids.set_grid_axis_index(Arc::new(GridAxisIndex::default()));
    assert!(!source.owns_decoder(&grids));
    for decoder in [&mut points, &mut placements, &mut grids] {
        assert!(!source.bind_decoder(decoder));
    }
}

#[test]
fn populated_foreign_grid_inverse_is_compatibility_only() {
    let bytes = b"DATA;#1=IFCGRIDAXIS('A',$,.T.);#9=IFCGRID('g',$,$,$,$,$,$,(#1),(),$);";
    let shared = Arc::new(GridAxisIndex::default());
    let mut foreign = EntityDecoder::new(bytes);
    foreign.set_grid_axis_index(shared.clone());
    assert_eq!(foreign.grid_of_axis(1), Some(9));
    let source = SourceBundle::new(b"DATA;#1=IFCGRIDAXIS('A',$,.T.);".to_vec());
    let mut bound = source.decoder();
    bound.set_grid_axis_index(shared);
    assert_eq!(
        bound.grid_of_axis(1),
        Some(9),
        "raw compatibility retains trusted behavior"
    );
    assert!(!source.owns_decoder(&bound));
    assert_eq!(
        source.decoder().grid_of_axis(1),
        None,
        "factory inverse stays independent"
    );
}

// Round-2 preservation: a typed move must never turn a lossless overflow into
// a successful strict geometry read, while ordinary records remain reusable.
#[test]
fn lossless_typed_transfer_preserves_strict_overflow_refusal() {
    let source =
        SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((1.E400,0.,0.));#2=IFCWALL();".to_vec());
    let mut lossless = source.decoder();
    assert!(lossless.decode_by_id_lossless(1).is_ok());
    lossless.decode_by_id(2).unwrap();
    let cache = lossless.drain_source_cache();
    let mut strict = source.decoder().with_strict_reals();
    assert!(strict.inject_source_cache(&cache));
    assert_eq!(strict.cache_size(), 1);
    assert_eq!(strict.decode_by_id(2).unwrap().ifc_type.as_str(), "IFCWALL");
    assert!(matches!(
        strict.decode_by_id(1),
        Err(crate::Error::UnrepresentableReal(1))
    ));
    assert_eq!(strict.refused_records(), 1);
    assert!(source.owns_decoder(&strict));
}

#[test]
fn rejected_foreign_transfers_preserve_all_populated_destination_caches() {
    let source = SourceBundle::new(
        b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));#2=IFCPOLYLOOP((#1,#1,#1));#4=IFCWALL();".to_vec(),
    );
    let foreign = SourceBundle::new(
        b"DATA;#1=IFCCARTESIANPOINT((9.,8.,7.));#2=IFCPOLYLOOP((#1,#1,#1));#4=IFCBEAM();".to_vec(),
    );
    let mut target = source.decoder();
    target.decode_by_id(4).unwrap();
    target.get_polyloop_coords_cached(2).unwrap();
    target.cache_placement_transform(3, [4.; 16]);
    let mut donor = foreign.decoder();
    donor.decode_by_id(4).unwrap();
    donor.get_polyloop_coords_cached(2).unwrap();
    donor.cache_placement_transform(3, [9.; 16]);
    let before = target.cache_size();
    assert!(!target.inject_source_cache(&donor.drain_source_cache()));
    assert!(!target.set_source_point_cache(donor.take_source_point_cache()));
    assert!(!target.set_source_placement_cache(donor.take_source_placement_cache()));
    assert_eq!(target.cache_size(), before);
    assert_eq!(target.decode_by_id(4).unwrap().ifc_type.as_str(), "IFCWALL");
    assert_eq!(
        target.get_polyloop_coords_cached(2).unwrap(),
        vec![(1., 2., 3.); 3]
    );
    assert_eq!(target.point_cache_stats(), (5, 1));
    assert_eq!(target.get_placement_transform_cached(3), Some([4.; 16]));
    assert!(source.owns_decoder(&target));
}
