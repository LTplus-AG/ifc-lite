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

/// The placement memo must survive a drain of the entity cache.
///
/// The two caches are worth very different amounts per byte: an entity-cache
/// entry saves one re-decode of one entity, while a memo entry can save
/// re-walking a chain thousands of elements share — a site or building
/// transform is composed once and read by every product beneath it. A caller
/// that drains on a size trigger while resolving placements (which is what makes
/// the trigger fire) would otherwise trade the expensive cache away to bound the
/// cheap one, and do it invisibly: output stays correct and the run gets slower
/// the larger the file.
#[test]
fn clearing_the_entity_cache_keeps_the_placement_memo() {
    let mut decoder = EntityDecoder::new("ISO-10303-21;\nDATA;\nENDSEC;\n");
    let m = [1.0f64; 16];
    decoder.cache_placement_transform(42, m);

    decoder.clear_entity_cache();
    assert_eq!(
        decoder.get_placement_transform_cached(42),
        Some(m),
        "the memo is the cache with cross-element value; draining the entity \
         cache must not take it"
    );

    // And the blunt one still means what it says.
    decoder.clear_cache();
    assert_eq!(
        decoder.get_placement_transform_cached(42),
        None,
        "clear_cache is documented as clearing all caches and must keep doing so"
    );
}

/// `length_unit_scale` must resolve an IMPERIAL length unit rather than
/// silently reporting metres.
///
/// The accessor used to call `units::try_extract_length_unit_scale`, which
/// returns `None` BY DESIGN for an `IFCCONVERSIONBASEDUNIT` length unit: it
/// defers the deeper name + `IFCMEASUREWITHUNIT` walk to the full-index path,
/// and its own doc tells the caller to retry "against a complete index before
/// trusting a metres default". It exists for the streaming pre-pass and its
/// PARTIAL index.
///
/// `length_unit_scale` is not that caller -- it scans the whole content with
/// `EntityScanner`, and its callers hold a complete index. So `.unwrap_or(1.0)`
/// collapsed that deliberate deferral into "metres" and read a foot-authored
/// model as a metre one, putting every absolute tolerance derived from it out
/// by 3.28x. It now calls the full `units::extract_length_unit_scale`, matching
/// `plane_angle_to_radians` directly above it.
#[test]
fn length_unit_scale_resolves_an_imperial_conversion_based_unit() {
    let content = r#"ISO-10303-21;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#10));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#5);
#10=IFCCONVERSIONBASEDUNIT(#11,.LENGTHUNIT.,'FOOT',#9);
#11=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
ENDSEC;
END-ISO-10303-21;
"#;
    let mut decoder = EntityDecoder::new(content);
    let scale = decoder.length_unit_scale();
    assert!(
        (scale - 0.3048).abs() < 1e-9,
        "foot-authored file must report the foot scale 0.3048, got {scale}"
    );
}

/// Bounding control for the test above: an SI metre file must STILL report
/// 1.0. Without this, "always return 0.3048" would satisfy the imperial test.
#[test]
fn length_unit_scale_still_reports_metres_for_an_si_metre_file() {
    let content = r#"ISO-10303-21;
DATA;
#1=IFCPROJECT('guid',$,'Test',$,$,$,$,(#2),#3);
#3=IFCUNITASSIGNMENT((#5));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
"#;
    let mut decoder = EntityDecoder::new(content);
    let scale = decoder.length_unit_scale();
    assert!(
        (scale - 1.0).abs() < 1e-12,
        "metre-authored file must still report 1.0, got {scale}"
    );
}

// --- Issue #3421: the raw-byte REFERENCE readers, not just the definition
// scanner, must refuse a `#<digits>` above `u32::MAX` rather than wrapping it
// onto a real low-numbered entity. #3395 fixed only the definition side
// (`EntityScanner`, see `parser::scanner_tests`); these pin the six decoder
// sites and the fast_parse pair have their own tests in `fast_parse_tests.rs`.
//
// `4294967297` is the defect value: `% 2^32 == 1`, so an unfixed reader binds
// it to a real `#1` rather than merely erroring. `4294967295` is `u32::MAX`
// exactly and must still resolve — the bound is inclusive.

/// One fixture exercised through BOTH the definition scanner and a reference
/// reader: `#4294967295` is a real, independently defined entity, distinct
/// from `#1`. If the reference readers ever grew a second, disagreeing copy
/// of the bound, this would show up as `#1`'s coordinates being served twice
/// (aliasing) or the boundary id's own coordinates going missing — not as a
/// bare "does it error" check.
#[test]
fn definition_and_reference_readers_agree_at_the_express_id_boundary() {
    let content = "\
#1=IFCCARTESIANPOINT((1.,1.,1.));
#4294967295=IFCCARTESIANPOINT((9.,9.,9.));
#2=IFCPOLYLOOP((#1,#4294967295,#4294967297));
";

    // Definition side: the scanner must see #1 and #4294967295 as distinct
    // entities, and #4294967297 is never a definition here at all.
    let mut scanner = EntityScanner::new(content);
    let mut defined_ids = Vec::new();
    while let Some((id, _type_name, _start, _end)) = scanner.next_entity() {
        defined_ids.push(id);
    }
    assert_eq!(defined_ids, vec![1, u32::MAX, 2]);

    // Reference side: get_polyloop_point_ids_fast reads the SAME
    // `#4294967295` and `#4294967297` bytes out of #2's attribute list.
    let mut decoder = EntityDecoder::new(content);
    let point_ids = decoder
        .get_polyloop_point_ids_fast(2)
        .expect("polyloop with two resolvable point refs");
    assert_eq!(
        point_ids,
        vec![1, u32::MAX],
        "the oversized ref must be dropped, and u32::MAX must resolve, matching the definition side"
    );
}

/// `get_polyloop_coords_fast` needs >= 3 resolved points to return a polygon
/// at all, so the previous test's 2-point case always yields `None` — this
/// isolates the "oversized ref dropped, others still resolve" behaviour with
/// enough real points to actually get coordinates back.
#[test]
fn get_polyloop_coords_fast_drops_oversized_ref_but_resolves_the_rest() {
    let content = "\
#1=IFCCARTESIANPOINT((1.,0.,0.));
#2=IFCCARTESIANPOINT((0.,1.,0.));
#4294967295=IFCCARTESIANPOINT((0.,0.,1.));
#3=IFCPOLYLOOP((#1,#2,#4294967295,#4294967297));
";
    let mut decoder = EntityDecoder::new(content);
    let coords = decoder
        .get_polyloop_coords_fast(3)
        .expect("3 of the 4 referenced points resolve, which is >= the minimum of 3");
    assert_eq!(
        coords,
        vec![(1., 0., 0.), (0., 1., 0.), (0., 0., 1.)],
        "the oversized ref (#4294967297) must be dropped, not aliased onto #1's coordinates"
    );
}

/// Same boundary, through the cached point-lookup path
/// (`get_polyloop_coords_cached`): the oversized ref must fail the whole
/// polygon's `coords.len() == expected_count` check (missing point, same as
/// any other unresolvable reference) rather than resolve via a wrapped alias.
#[test]
fn get_polyloop_coords_cached_rejects_oversized_ref() {
    let content = "\
#1=IFCCARTESIANPOINT((1.,0.,0.));
#2=IFCCARTESIANPOINT((0.,1.,0.));
#3=IFCPOLYLOOP((#1,#2,#4294967297));
";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(
        decoder.get_polyloop_coords_cached(3),
        None,
        "an oversized ref must leave the polygon short of expected_count, not resolve via alias"
    );
}

/// `get_polyloop_point_ids_fast` (issue #3421): pins the drop-not-alias
/// behaviour directly, independent of the combined test above.
#[test]
fn get_polyloop_point_ids_fast_drops_oversized_ref() {
    let content = "#1=IFCPOLYLOOP((#2,#4294967297,#4294967295));\n";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(
        decoder.get_polyloop_point_ids_fast(1),
        Some(vec![2, u32::MAX])
    );
}

/// `get_entity_ref_list_fast` (issue #3421): same contract as
/// `get_polyloop_point_ids_fast`, different accessor and record shape.
#[test]
fn get_entity_ref_list_fast_drops_oversized_ref() {
    let content = "#1=IFCCLOSEDSHELL((#2,#4294967297,#4294967295));\n";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(
        decoder.get_entity_ref_list_fast(1),
        Some(vec![2, u32::MAX])
    );
}

/// `get_first_entity_ref_fast` (issue #3421): an oversized first reference
/// must refuse (`None`), not resolve to `#1`.
#[test]
fn get_first_entity_ref_fast_refuses_oversized_ref() {
    let content = "#1=IFCMAPPEDITEM(#4294967297,$);\n";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(decoder.get_first_entity_ref_fast(1), None);

    // Control: the same accessor resolves an ordinary reference, and the
    // inclusive boundary (u32::MAX) still resolves too.
    let content = "#1=IFCMAPPEDITEM(#4294967295,$);\n";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(decoder.get_first_entity_ref_fast(1), Some(u32::MAX));
}

/// `get_face_bound_fast` (issue #3421): an oversized loop reference must
/// refuse the whole face bound (`None`), not resolve to a real, wrong loop.
#[test]
fn get_face_bound_fast_refuses_oversized_loop_ref() {
    let content = "#1=IFCFACEBOUND(#4294967297,.T.);\n";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(decoder.get_face_bound_fast(1), None);

    // Control: the inclusive boundary still resolves, with the right id.
    let content = "#1=IFCFACEBOUND(#4294967295,.T.);\n";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(decoder.get_face_bound_fast(1), Some((u32::MAX, true, false)));
}
