// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super::EntityDecoder`]. Extracted from `decoder.rs` into
//! this ratchet-exempt `*_tests.rs` sibling (child module, keeps `super::*`
//! access) so the production module stays under its module-size budget.

use super::*;
use crate::IfcType;

#[test]
fn test_decode_entity() {
    let content = r#"
#1=IFCPROJECT('2vqT3bvqj9RBFjLlXpN8n9',$,$,$,$,$,$,$,$);
#2=IFCWALL('3a4T3bvqj9RBFjLlXpN8n0',$,$,$,'Wall-001',$,#3,#4);
#3=IFCLOCALPLACEMENT($,#4);
#4=IFCAXIS2PLACEMENT3D(#5,$,$);
#5=IFCCARTESIANPOINT((0.,0.,0.));
"#;

    let mut decoder = EntityDecoder::new(content);

    // Find entity #2
    let start = content.find("#2=").unwrap();
    let end = content[start..].find(';').unwrap() + start + 1;

    let entity = decoder.decode_at(start, end).unwrap();
    assert_eq!(entity.id, 2);
    assert_eq!(entity.ifc_type, IfcType::IfcWall);
    assert_eq!(entity.attributes.len(), 8);
    assert_eq!(entity.get_string(4), Some("Wall-001"));
    assert_eq!(entity.get_ref(6), Some(3));
    assert_eq!(entity.get_ref(7), Some(4));
}

#[test]
fn test_decode_by_id() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#5=IFCWALL('guid2',$,$,$,'Wall-001',$,$,$);
#10=IFCDOOR('guid3',$,$,$,'Door-001',$,$,$);
"#;

    let mut decoder = EntityDecoder::new(content);

    let entity = decoder.decode_by_id(5).unwrap();
    assert_eq!(entity.id, 5);
    assert_eq!(entity.ifc_type, IfcType::IfcWall);
    assert_eq!(entity.get_string(4), Some("Wall-001"));

    // Should be cached now
    assert_eq!(decoder.cache_size(), 1);
    let cached = decoder.get_cached(5).unwrap();
    assert_eq!(cached.id, 5);
}

#[test]
fn test_build_entity_index_matches_scanner_header_semantics() {
    let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n\
FILE_NAME('26-IFC\\X2\\00B1\\X0\\2#.ifc','2026-04-29T18:21:27',$,$,'CATIA','CATIA',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('guid2',$,$,$,'Wall; with semicolon',$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    let index = build_entity_index(content);

    assert_eq!(index.len(), 2);
    assert!(!index.contains_key(&26));
    let (start, end) = index.get(&2).copied().unwrap();
    assert_eq!(
        &content[start..end],
        "#2=IFCWALL('guid2',$,$,$,'Wall; with semicolon',$,$,$);"
    );
}

#[test]
fn test_decode_by_id_handles_quoted_semicolon_from_shared_index() {
    let content = "#1=IFCWALL('guid',$,$,$,'Wall; with semicolon',$,$,$);\n";
    let mut decoder = EntityDecoder::new(content);

    let wall = decoder.decode_by_id(1).unwrap();

    assert_eq!(wall.id, 1);
    assert_eq!(wall.ifc_type, IfcType::IfcWall);
    assert_eq!(wall.get_string(4), Some("Wall; with semicolon"));
}

#[test]
fn test_resolve_ref() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,#1,$);
"#;

    let mut decoder = EntityDecoder::new(content);

    let wall = decoder.decode_by_id(2).unwrap();
    let placement_attr = wall.get(6).unwrap();

    let referenced = decoder.resolve_ref(placement_attr).unwrap().unwrap();
    assert_eq!(referenced.id, 1);
    assert_eq!(referenced.ifc_type, IfcType::IfcProject);
}

#[test]
fn test_resolve_ref_list() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid1',$,$,$,$,$,$,$);
#3=IFCDOOR('guid2',$,$,$,$,$,$,$);
#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('guid3',$,$,$,(#2,#3),$,#1);
"#;

    let mut decoder = EntityDecoder::new(content);

    let rel = decoder.decode_by_id(4).unwrap();
    let elements_attr = rel.get(4).unwrap();

    let elements = decoder.resolve_ref_list(elements_attr).unwrap();
    assert_eq!(elements.len(), 2);
    assert_eq!(elements[0].id, 2);
    assert_eq!(elements[0].ifc_type, IfcType::IfcWall);
    assert_eq!(elements[1].id, 3);
    assert_eq!(elements[1].ifc_type, IfcType::IfcDoor);
}

#[test]
fn test_cache() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,$,$);
"#;

    let mut decoder = EntityDecoder::new(content);

    assert_eq!(decoder.cache_size(), 0);

    decoder.decode_by_id(1).unwrap();
    assert_eq!(decoder.cache_size(), 1);

    decoder.decode_by_id(2).unwrap();
    assert_eq!(decoder.cache_size(), 2);

    // Decode same entity - should use cache
    decoder.decode_by_id(1).unwrap();
    assert_eq!(decoder.cache_size(), 2);

    decoder.clear_cache();
    assert_eq!(decoder.cache_size(), 0);
}

/// Two IfcPolyLoops that reference a SHARED set of CartesianPoints: extracting
/// the second loop must be served entirely from the point cache the first loop
/// populated, so `point_cache_stats().hits` is non-zero. This is the decoder-level
/// proof of the memoization the per-worker hoist relies on; the coordinates
/// returned are identical whether or not the cache was warm.
#[test]
fn polyloop_point_cache_memoizes_shared_points() {
    // Both #20 and #21 share the same four CartesianPoints (#10..#13).
    let content = "\
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCCARTESIANPOINT((1.,0.,0.));
#12=IFCCARTESIANPOINT((1.,1.,0.));
#13=IFCCARTESIANPOINT((0.,1.,0.));
#20=IFCPOLYLOOP((#10,#11,#12,#13));
#21=IFCPOLYLOOP((#10,#11,#12,#13));
";
    let mut decoder = EntityDecoder::new(content);

    let first = decoder.get_polyloop_coords_cached(20).expect("first loop resolves");
    let (hits_after_first, misses_after_first) = decoder.point_cache_stats();
    // First loop parses every point fresh: four misses, zero hits.
    assert_eq!(hits_after_first, 0);
    assert_eq!(misses_after_first, 4);

    let second = decoder.get_polyloop_coords_cached(21).expect("second loop resolves");
    let (hits, misses) = decoder.point_cache_stats();
    // Second loop reuses the four cached points: four more hits, no new misses.
    assert!(hits > 0, "expected point-cache hits across loops, got {hits}");
    assert_eq!(hits, 4);
    assert_eq!(misses, 4);

    // Memoization changes speed, not results: identical coordinates both times.
    assert_eq!(first, second);
    assert_eq!(
        first,
        vec![(0., 0., 0.), (1., 0., 0.), (1., 1., 0.), (0., 1., 0.)]
    );
}

/// `take_point_cache` / `set_point_cache` move the warm cache between decoders
/// (the hoist primitive): a second decoder that adopts the first's cache serves
/// the same shared loop entirely from cache hits, without re-parsing any point.
#[test]
fn point_cache_survives_take_and_set_across_decoders() {
    let content = "\
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCCARTESIANPOINT((1.,0.,0.));
#12=IFCCARTESIANPOINT((1.,1.,0.));
#20=IFCPOLYLOOP((#10,#11,#12));
#21=IFCPOLYLOOP((#10,#11,#12));
";
    let mut warm = EntityDecoder::new(content);
    let a = warm.get_polyloop_coords_cached(20).expect("warm loop resolves");
    assert_eq!(warm.point_cache_stats(), (0, 3));

    // Hand the warm cache to a FRESH decoder (its own counters start at 0).
    let mut adopter = EntityDecoder::new(content);
    adopter.set_point_cache(warm.take_point_cache());
    let b = adopter.get_polyloop_coords_cached(21).expect("adopter loop resolves");
    let (hits, misses) = adopter.point_cache_stats();
    assert_eq!(hits, 3, "adopted cache should serve every point as a hit");
    assert_eq!(misses, 0);
    assert_eq!(a, b);

    // The donor decoder gave its cache away.
    assert!(warm.take_point_cache().is_empty());
}

/// Regression guard for the hoist's decode-error path (see
/// `processor::jobs::WorkerCacheGuard`). When a worker's element hits a
/// `decode_at` failure, its decoder must NOT lose the warm cache: `take_point_cache`
/// after the failed decode still yields the accumulated entries, so the worker's
/// NEXT element adopts them and serves its shared loop from cache hits. Before the
/// RAII guard, the failing element early-returned and dropped the warm cache,
/// cold-starting the rest of the worker's sub-range and silently defeating the hoist.
#[test]
fn point_cache_survives_a_failed_decode_between_elements() {
    let content = "\
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCCARTESIANPOINT((1.,0.,0.));
#12=IFCCARTESIANPOINT((1.,1.,0.));
#20=IFCPOLYLOOP((#10,#11,#12));
#21=IFCPOLYLOOP((#10,#11,#12));
";
    // Element 1 warms the worker's cache.
    let mut warm = EntityDecoder::new(content);
    warm.get_polyloop_coords_cached(20).expect("warm loop resolves");
    assert_eq!(warm.point_cache_stats(), (0, 3));
    let carried = warm.take_point_cache();

    // Element 2's decoder adopts the warm cache, then hits a decode FAILURE
    // (out-of-range span -> Err, not a panic). This is the case the guard exists
    // for: on Drop it takes the point cache back instead of losing it.
    let mut failing = EntityDecoder::new(content);
    failing.set_point_cache(carried);
    assert!(
        failing.decode_at(10_000, 10_010).is_err(),
        "out-of-range decode should fail without clearing the cache"
    );
    let recovered = failing.take_point_cache();
    assert_eq!(
        recovered.len(),
        3,
        "a failed decode must not drop the worker's warm point cache"
    );

    // Element 3 in the same worker adopts the recovered cache: every shared point
    // is a hit, none re-parsed - proving the failure did not cold-start the chunk.
    let mut next = EntityDecoder::new(content);
    next.set_point_cache(recovered);
    next.get_polyloop_coords_cached(21).expect("next loop resolves");
    let (hits, misses) = next.point_cache_stats();
    assert!(
        hits > 0,
        "expected warm-cache hits after a failed decode, got {hits}"
    );
    assert_eq!((hits, misses), (3, 0));
}
