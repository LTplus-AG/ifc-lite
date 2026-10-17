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

/// F4 M-geom (CORE-10): trivia between the `=` and the keyword is trivia. The
/// keyword read used to compare the bytes after `=`, so `#8=/* root */IFCFACETEDBREP(`
/// was "not a brep" and took the generic walk (a different key space, and no
/// share through the cache); it is the same brep as the plain record now, with
/// the same signature, shared the same way.
#[test]
fn brep_keyword_trivia_is_the_same_brep_signature() {
    let key_of = |content: &str| {
        let mut decoder = EntityDecoder::new(content);
        let item = decoder.decode_by_id(8).unwrap();
        let cache = GeometryRouter::new_brep_signature_cache();
        let shared = router(cache.clone(), 1.0, TessellationQuality::Medium);
        let key = shared.item_dedup_key(&item, &mut decoder);
        let shared_entries = cache.0.lock().unwrap().len();
        (key, shared_entries)
    };
    let plain = triangle_brep(1.0);
    let (plain_key, plain_shared) = key_of(&plain);
    assert!(plain_key.is_some() && plain_shared == 1, "control: the plain brep is shared");
    for head in ["#8=/* root */IFCFACETEDBREP", "#8= /* a, ( */ IFCFACETEDBREP", "#8=ifcfacetedbrep"] {
        let content = plain.replace("#8=IFCFACETEDBREP", head);
        assert_eq!(key_of(&content), (plain_key, plain_shared), "{head}");
    }
}

#[test]
fn issue_7714_warped_source_identity_survives_shared_memos_and_boolean_parents() {
    let source = format!("{}\n#900011=IFCFACETEDBREP(#489633);\n\
        #900012=IFCBOOLEANRESULT(.DIFFERENCE.,#489635,#489635);\n\
        #900013=IFCBOOLEANRESULT(.DIFFERENCE.,#900011,#900011);",
        include_str!("../../tests/fixtures/issue_7714_soffice_carrier.ifc"));
    let cache = GeometryRouter::new_brep_signature_cache();
    for _ in 0..2 {
        let mut decoder = EntityDecoder::new(&source);
        let router = router(cache.clone(), 0.001,TessellationQuality::Medium);
        let mut keys=Vec::new();
        for id in [489635,900011,900012,900013] {
            let item=decoder.decode_by_id(id).unwrap();
            let key=router.item_dedup_key(&item,&mut decoder).unwrap();
            assert!(!keys.contains(&key),"source-sensitive subtrees cannot share meshes");
            assert_eq!(router.item_dedup_key(&item,&mut decoder),Some(key),"memo hit preserves identity");
            keys.push(key);
        }
    }
}

#[test]
fn issue_7714_generic_brep_fallback_keeps_source_identity() {
    let source="#1=IFCFACETEDBREP(#99);#2=IFCFACETEDBREP(#99);\
        #3=IFCBOOLEANRESULT(.UNION.,#1,#1);#4=IFCBOOLEANRESULT(.UNION.,#2,#2);";
    let mut decoder=EntityDecoder::new(source);
    let router=router(GeometryRouter::new_brep_signature_cache(),1.,TessellationQuality::Medium);
    let mut keys=Vec::new();
    for id in 1..=4 {
        let item=decoder.decode_by_id(id).unwrap();
        let key=router.item_dedup_key(&item,&mut decoder).unwrap();
        assert!(!keys.contains(&key));keys.push(key);
    }
}

#[test]
fn issue_7714_commented_reference_cannot_hide_a_normalizable_source_from_cache_identity() {
    // The existing first-reference reader can see the decoy's #7 in a comment.
    // The carrier cache policy must consult actual source admission rather
    // than mistake that triangle for either seven-face source item (#7714).
    let source = format!("{}\n{}\n\
        #900011=IFCFACETEDBREP(/*#7*/#489633);\n\
        #900012=IFCFACETEDBREP(/*#7*/#489633);",
        include_str!("../../tests/fixtures/issue_7714_soffice_carrier.ifc"), triangle_brep(1.0));
    let mut decoder = EntityDecoder::new(&source);
    let shared = router(GeometryRouter::new_brep_signature_cache(), 0.001, TessellationQuality::Medium);
    let keys: Vec<_> = [8, 900011, 900012].into_iter().map(|id| {
        let item = decoder.decode_by_id(id).unwrap();
        shared.item_dedup_key(&item, &mut decoder).unwrap()
    }).collect();
    assert_ne!(keys[0], keys[1], "a source carrier cannot borrow the decoy triangle mesh");
    assert_ne!(keys[1], keys[2], "actual warped items retain source identity");
}

#[test]
fn issue_7714_warp_without_existing_adjacent_carrier_preserves_structural_reuse() {
    // Move the third carrier corner off its plane. The real source remains
    // warped but cannot select the existing adjacent carrier, so both items
    // must retain structural cache equivalence through memo hits and parents.
    let source = format!("{}\n#900011=IFCFACETEDBREP(#489633);\n\
        #900012=IFCBOOLEANRESULT(.DIFFERENCE.,#489635,#489635);\n\
        #900013=IFCBOOLEANRESULT(.DIFFERENCE.,#900011,#900011);",
        include_str!("../../tests/fixtures/issue_7714_soffice_carrier.ifc")
            .replace("95.0000003725,12000.0000131,-325.", "95.0001,12000.0000131,-325."));
    let cache = GeometryRouter::new_brep_signature_cache();
    for _ in 0..2 {
        let mut decoder = EntityDecoder::new(&source);
        let router = router(cache.clone(), 0.001, TessellationQuality::Medium);
        let mut key = |id| {
            let item = decoder.decode_by_id(id).unwrap();
            router.item_dedup_key(&item, &mut decoder).unwrap()
        };
        assert_eq!(key(489635), key(900011));
        assert_eq!(key(900012), key(900013));
        assert_eq!(key(489635), key(900011));
    }
}
