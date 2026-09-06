// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn triangle_brep(width: f64) -> String {
    format!("#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT(({width:.1},0.,0.));\n\
        #3=IFCCARTESIANPOINT((0.,1.,0.));\n\
        #4=IFCPOLYLOOP((#1,#2,#3));\n\
        #5=IFCFACEOUTERBOUND(#4,.T.);\n\
        #6=IFCFACE((#5));\n\
        #7=IFCCLOSEDSHELL((#6));\n\
        #8=IFCFACETEDBREP(#7);\n")
}

fn router(cache: SharedBrepSignatureCache, scale: f64, quality: TessellationQuality) -> GeometryRouter {
    let mut router = GeometryRouter::with_scale_and_quality(scale, quality);
    router.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
    router.enable_shared_brep_signature_cache(cache);
    router
}

/// A shared completed root eliminates the second point traversal even when a
/// fresh decoder/router is used, while parameters still change the mesh key.
#[test]
fn completed_brep_signature_reuses_walk_across_routers_and_preserves_parameter_keys() {
    let content = triangle_brep(2.0);
    let cache = GeometryRouter::new_brep_signature_cache();
    let mut keys = Vec::new();
    for (i, (scale, quality, rtc)) in [
        (1.0, TessellationQuality::Medium, (0.0, 0.0, 0.0)),
        (0.001, TessellationQuality::Medium, (0.0, 0.0, 0.0)),
        (1.0, TessellationQuality::Highest, (0.0, 0.0, 0.0)),
        (1.0, TessellationQuality::Medium, (1.0, 2.0, 3.0)),
    ].into_iter().enumerate() {
        let mut decoder = EntityDecoder::new(&content);
        let item = decoder.decode_by_id(8).unwrap();
        let mut shared = router(cache.clone(), scale, quality);
        shared.set_rtc_offset(rtc);
        let key = shared.item_dedup_key(&item, &mut decoder).unwrap();
        let (hits, misses) = decoder.point_cache_stats();
        if i == 0 { assert!(hits + misses > 0); } else { assert_eq!(hits + misses, 0); }
        assert!(!keys.contains(&key), "router parameters must remain part of the final key");
        keys.push(key);
        let actual = shared.process_representation_item(&item, &mut decoder).unwrap();
        let mut fresh_decoder = EntityDecoder::new(&content);
        let mut fresh = router(GeometryRouter::new_brep_signature_cache(), scale, quality);
        fresh.shared_brep_signatures = None;
        fresh.set_rtc_offset(rtc);
        assert_eq!(fresh.item_dedup_key(&item, &mut fresh_decoder), Some(key));
        let expected = fresh.process_representation_item(&item, &mut fresh_decoder).unwrap();
        assert!(!actual.positions.is_empty());
        assert_eq!(actual.positions, expected.positions);
        assert_eq!(actual.normals, expected.normals);
        assert_eq!(actual.indices, expected.indices);
    }
}

#[test]
fn distinct_models_with_same_root_id_have_independent_signatures() {
    let mut keys = Vec::new();
    for width in [1.0, 2.0] {
        let content = triangle_brep(width);
        let mut decoder = EntityDecoder::new(&content);
        let item = decoder.decode_by_id(8).unwrap();
        let router = router(GeometryRouter::new_brep_signature_cache(), 1.0, TessellationQuality::Medium);
        keys.push(router.item_dedup_key(&item, &mut decoder).unwrap());
    }
    assert_ne!(keys[0], keys[1]);
}

/// Refused fast walks stay local, so a cache hit cannot suppress diagnostics
/// from the generic fallback or turn a partial hash into a completed one.
#[test]
fn malformed_brep_fallback_is_not_shared_and_preserves_refusals() {
    let content = "#7=IFCCLOSEDSHELL((#4294967297));\n#8=IFCFACETEDBREP(#7);";
    let cache = GeometryRouter::new_brep_signature_cache();
    for _ in 0..2 {
        let mut decoder = EntityDecoder::new(content);
        let item = decoder.decode_by_id(8).unwrap();
        let shared = router(cache.clone(), 1.0, TessellationQuality::Medium);
        let actual = shared.item_dedup_key(&item, &mut decoder);
        let mut fresh_decoder = EntityDecoder::new(content);
        let mut fresh = GeometryRouter::new();
        fresh.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
        assert_eq!(actual, fresh.item_dedup_key(&item, &mut fresh_decoder));
        assert_eq!(*shared.content_hash_oversized_ref_drops.borrow(), 1);
        assert_eq!(*shared.content_hash_oversized_ref_drops.borrow(), *fresh.content_hash_oversized_ref_drops.borrow());
        assert!(cache.0.lock().unwrap().is_empty());
    }
}

#[test]
fn shared_signature_cache_retains_large_brep_threshold() {
    let faces = std::iter::repeat_n("#6", super::super::content_hash::FACETED_BREP_DEDUP_FACE_LIMIT + 1)
        .collect::<Vec<_>>().join(",");
    let content = triangle_brep(1.0).replace("IFCCLOSEDSHELL((#6))", &format!("IFCCLOSEDSHELL(({faces}))"));
    let cache = GeometryRouter::new_brep_signature_cache();
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(8).unwrap();
    let router = router(cache.clone(), 1.0, TessellationQuality::Medium);
    assert_eq!(router.item_dedup_key(&item, &mut decoder), None);
    assert_eq!(decoder.point_cache_stats(), (0, 0));
    assert!(cache.0.lock().unwrap().is_empty());
}

#[test]
fn brep_keyword_trivia_keeps_the_original_signature_path() {
    let content = triangle_brep(1.0).replace("#8=IFCFACETEDBREP", "#8=/* root */IFCFACETEDBREP");
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(8).unwrap();
    let cache = GeometryRouter::new_brep_signature_cache();
    let shared = router(cache.clone(), 1.0, TessellationQuality::Medium);
    let actual = shared.item_dedup_key(&item, &mut decoder);
    let mut fresh = GeometryRouter::new();
    fresh.enable_content_dedup_shared(GeometryRouter::new_dedup_cache());
    let mut fresh_decoder = EntityDecoder::new(&content);
    assert_eq!(actual, fresh.item_dedup_key(&item, &mut fresh_decoder));
    assert!(cache.0.lock().unwrap().is_empty());
}
