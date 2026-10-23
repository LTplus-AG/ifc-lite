// SPDX-License-Identifier: MPL-2.0
//! #7873 armed-plan eligibility must not resolve an unadmitted Items list.
use super::*;
use std::sync::Arc;

fn armed(template: u32) -> GeometryRouter {
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    router.enable_output_instancing(Arc::new([(6, (2, template))].into_iter().collect()));
    router
}

fn first_step(program: &mut GeometryProgram<'_>, router: &GeometryRouter, decoder: &mut EntityDecoder) {
    let request = program.request().unwrap().unwrap();
    let reply = program.execute(request, router, decoder).unwrap();
    program.accept(reply, router).unwrap_or_else(|_| panic!("owner accepts"));
}

#[test]
fn issue_7873_armed_default_cap_refuses_before_invalid_first_or_ignored_slot_member_decode() {
    let cap = crate::representation::MAX_WALK_LEVELS;
    for first in ["#90,#4", "#999999,#4", "#4"] {
        let items = format!("{first},{}", vec!["$"; cap as usize].join(","));
        let source = format!("{}#90=IFCCARTESIANPOINT((1.E400,0.,0.));",
            SOURCE.replace("(#4)", &format!("({items})")));
        for template in [8, 999] {
            let router = armed(template);
            let mut decoder = EntityDecoder::new(&source).with_strict_reals();
            let root = decoder.decode_by_id(8).unwrap();
            let mut program = GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
                None, router.rtc_offset());
            // Eligibility is a separate Source step before StyledItems. Even
            // one real reference among ignored slots must not be decoded here.
            first_step(&mut program, &router, &mut decoder);
            assert!(decoder.get_cached(4).is_none());
            assert_eq!(decoder.refused_records(), 0, "invalid first member was not probed");
            let error = program.drain_styled(&router, &mut decoder).unwrap_err();
            assert!(error.to_string().contains("work budget"), "{error}");
            assert!(decoder.get_cached(4).is_none());
            assert_eq!(decoder.refused_records(), 0);
            // A claimed/cached-source retry still cannot perform a skipped scan.
            let error = GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
                None, router.rtc_offset()).drain_styled(&router, &mut decoder).unwrap_err();
            assert!(error.to_string().contains("work budget"));
            assert!(decoder.get_cached(4).is_none());
            assert_eq!(decoder.refused_records(), 0);
            assert_eq!(router.mapped_shared_unique_count(), 0);
            assert!(router.take_unsupported_items().is_empty());
            assert_eq!(router.unsupported_scope_depth(), 0);
        }
    }
}

#[test]
fn issue_7873_armed_root_attempt_admits_one_eligibility_decode_but_zero_admits_none() {
    for template in [8, 999] {
        for limit in [0, 1] {
            let router = armed(template);
            let mut decoder = EntityDecoder::new(SOURCE);
            let root = decoder.decode_by_id(8).unwrap();
            let mut program = limited(GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
                None, router.rtc_offset()), limit);
            first_step(&mut program, &router, &mut decoder);
            assert_eq!(decoder.get_cached(4).is_some(), limit == 1);
            let result = program.drain_styled(&router, &mut decoder);
            if limit == 0 {
                assert!(result.unwrap_err().to_string().contains("work budget"));
                assert!(decoder.get_cached(6).is_none(), "zero refuses before source resolution too");
            } else {
                let parts = result.unwrap();
                assert_eq!(parts.len(), 1);
                let part = &parts.sub_meshes[0];
                assert_eq!(part.geometry_id, 4);
                assert_eq!(part.mesh.indices.len(), if template == 8 { 3 } else { 0 });
                assert_eq!(part.mesh.instance_meta.as_ref().unwrap().rep_identity, 6);
            }
        }
    }
}

#[test]
fn issue_7873_armed_malformed_items_fall_through_without_early_member_decode() {
    // Raw zero/multiple/nested/wrong-shaped/bare/dangling Items preserve the
    // flat materializer's content result. Ignored slots intentionally forbid
    // placeholders, even where resolve_ref_list would find just one reference.
    for (items, indices) in [("()", Some(0)), ("(#4,#4)", Some(6)),
        ("((#4))", Some(0)), ("($)", Some(0)), ("(#4,$,17)", Some(3)),
        ("#4", None), ("17", None), ("(#999999)", None)] {
        let source = SOURCE.replace("(#4)", items);
        let router = armed(999);
        let mut decoder = EntityDecoder::new(&source);
        let root = decoder.decode_by_id(8).unwrap();
        let mut program = GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
            None, router.rtc_offset());
        first_step(&mut program, &router, &mut decoder);
        assert!(decoder.get_cached(4).is_none(), "early decode for {items}");
        let result = program.drain_styled(&router, &mut decoder);
        match indices {
            Some(expected) => {
                let parts = result.unwrap();
                assert_eq!(parts.sub_meshes.iter().map(|p| p.mesh.indices.len()).sum::<usize>(), expected, "{items}");
                assert!(parts.sub_meshes.iter().all(|p| !p.mesh.positions.is_empty()));
            }
            None => assert!(!result.unwrap_err().to_string().contains("work budget")),
        }
        assert_eq!(router.mapped_shared_unique_count(), 0, "no placeholder registration for {items}");
    }
}

#[test]
fn issue_7873_wrong_class_representation_uses_nonasserting_missing_items_fallback() {
    // The representation reference is malformed. Do not assert an EXPRESS
    // owner on it just to inspect eligibility; positional absence stays empty.
    let source = SOURCE.replace("IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#4))", "IFCPOLYLINE((#4))");
    let router = armed(999);
    let mut decoder = EntityDecoder::new(&source);
    let root = decoder.decode_by_id(8).unwrap();
    let parts = GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
        None, router.rtc_offset()).drain_styled(&router, &mut decoder).unwrap();
    assert!(parts.is_empty());
    assert!(decoder.get_cached(4).is_none());
    assert_eq!(router.mapped_shared_unique_count(), 0);
}

#[test]
fn issue_7873_armed_nested_map_stays_flat_and_does_not_eligibility_decode_its_child() {
    let source = format!("{}#25=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#4));\
        #26=IFCREPRESENTATIONMAP(#2,#25);#18=IFCMAPPEDITEM(#26,#7);",
        SOURCE.replace("(#4)", "(#18)"));
    let mut decoder = EntityDecoder::new(&source);
    let root = decoder.decode_by_id(8).unwrap();
    let router = armed(999);
    let mut program = limited(GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
        None, router.rtc_offset()), 1);
    first_step(&mut program, &router, &mut decoder);
    assert!(decoder.get_cached(18).is_some(), "one bounded eligibility decode");
    assert!(decoder.get_cached(4).is_none());
    // Root Items spends the only member slot; the nested mapped attempt is
    // refused before resolving its source or probing child eligibility.
    let parts = program.drain_styled(&router, &mut decoder).unwrap();
    assert!(parts.is_empty());
    assert!(decoder.get_cached(26).is_none());
    assert!(decoder.get_cached(4).is_none());
    assert_eq!(router.take_unsupported_items().get("IfcMappedItem"), Some(&1));
    let parts = GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), true,
        None, router.rtc_offset()).drain_styled(&router, &mut decoder).unwrap();
    assert_eq!(parts.sub_meshes[0].mesh.indices.len(), 3);
    assert_eq!(parts.sub_meshes[0].geometry_id, 4);
    assert_eq!(router.mapped_shared_unique_count(), 0);
}

#[test]
fn issue_7873_exact_single_keeps_plan_count_colour_and_texture_gates() {
    use crate::processors::texture::{ImageTextureRef, ResolvedTextureMap, TextureSource};
    let textures = [(4, ResolvedTextureMap {
        texture_id: 100,
        texture: TextureSource::Image(ImageTextureRef {
            url: "fixture.png".into(), repeat_s: true, repeat_t: true,
        }),
        tex_coords: vec![[0., 0.], [1., 0.], [0., 1.]],
        tex_coord_index: None,
    })].into_iter().collect();
    // Every gate forces real geometry even for a non-template occurrence.
    for gate in 0..5 {
        let mut router = armed(999);
        if gate == 0 { router.enable_output_instancing(Arc::new(FxHashMap::default())); }
        if gate == 1 { router.enable_output_instancing(Arc::new([(6, (1, 999))].into_iter().collect())); }
        if gate == 2 { router.enable_indexed_colour_split_guard(Arc::new([4].into_iter().collect())); }
        let mut decoder = EntityDecoder::new(SOURCE);
        let root = decoder.decode_by_id(8).unwrap();
        let parts = GeometryProgram::styled_item(&root, crate::SubMeshCollection::new(), gate != 4,
            (gate == 3).then_some(&textures), router.rtc_offset()).drain_styled(&router, &mut decoder).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts.sub_meshes[0].geometry_id, 4);
        assert_eq!(parts.sub_meshes[0].mesh.indices.len(), 3, "gate {gate}");
        assert_eq!(parts.sub_meshes[0].texture.is_some(), gate == 3);
        assert_eq!(router.mapped_shared_unique_count(), 0);
    }
}
