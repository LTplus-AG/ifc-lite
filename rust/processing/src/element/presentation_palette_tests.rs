// SPDX-License-Identifier: MPL-2.0
//! Presentation palette/UV invariants on real meshed STEP tetrahedra.
use super::session_tests::{job, metadata, options, SOURCE};
use super::*;
use std::sync::Arc;

fn source() -> String {
    SOURCE
        .replace(
            "#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);",
            "#13=IFCTRIANGULATEDFACESET(#16,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);\n\
         #16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));\n\
         #200=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/tetra.png');\n\
         #201=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(1.,1.)));\n\
         #202=IFCINDEXEDTRIANGLETEXTUREMAP((#200),#13,#201,$);\n\
         #210=IFCCOLOURRGBLIST(((1.,0.,0.),(0.,1.,0.)));\n\
         #211=IFCINDEXEDCOLOURMAP(#13,$,#210,(1,2,1,2));",
        )
        .replace("'Body','SweptSolid',(#13)", "'Body','Tessellation',(#13)")
}
fn data(source: &str, decoder: &mut EntityDecoder) -> OwnedMeshProductionData {
    let full =
        crate::style::resolve_indexed_colour_map_full(&decoder.decode_by_id(211).unwrap(), decoder)
            .unwrap();
    OwnedMeshProductionData {
        indexed_colour_full: Arc::new([(13, full)].into_iter().collect()),
        texture_index: Arc::new(ifc_lite_geometry::build_texture_index(
            source.as_bytes(),
            decoder,
        )),
        ..Default::default()
    }
}

#[test]
fn presentation_real_texture_and_type_map_keep_uv_pairs_style_and_hash_exclusion() {
    let source = source();
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_units(&source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let mut inputs = data(&source, &mut decoder);
    let color = [0.2, 0.4, 0.9, 0.7];
    inputs.geometry_style_index = Arc::new(
        [(13, GeometryStyleInfo::from_color(color))]
            .into_iter()
            .collect(),
    );
    let context = ProductionModel::new().snapshot(inputs);
    for types in [false, true] {
        let entity = decoder.decode_by_id(if types { 60 } else { 10 }).unwrap();
        let meta = metadata(entity.id);
        let mut input = job(&entity, &meta);
        if types {
            input.kind = ElementJobKind::TypeProduct {
                rep_maps: vec![(61, 2)],
            };
        }
        let result =
            produce_element_meshes_owned(&input, &context, &options(), &mut decoder, &router)
                .unwrap();
        assert_eq!(
            result.meshes.len(),
            1,
            "valid texture wins over the two-colour palette"
        );
        let mesh = &result.meshes[0];
        assert_eq!(mesh.color, color);
        assert_eq!(
            mesh.texture.as_ref().unwrap().url.as_deref(),
            Some("textures/tetra.png")
        );
        assert_eq!(
            mesh.uvs.as_ref().unwrap().len(),
            mesh.positions.len() / 3 * 2
        );
        assert_eq!(mesh.geometry_class, if types { 2 } else { 0 });
        assert_eq!(result.geometry_hash.is_none(), types);
        assert_eq!(mesh.indices.len(), 12);
        assert_eq!(mesh.properties, meta.space_zone_properties);
    }
}

#[test]
fn presentation_invalid_uv_falls_through_to_palette_and_retopology_rejects_it() {
    let source = source();
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_units(&source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let inputs = data(&source, &mut decoder);
    let context = ProductionModel::new().snapshot(inputs);
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let ctx = context.borrowed();
    let mut submeshes = router
        .process_element_with_submeshes_textured(&entity, &mut decoder, ctx.texture_index)
        .unwrap();
    assert_eq!(submeshes.len(), 1);
    assert!(
        submeshes.sub_meshes[0].texture.is_some(),
        "actual texture-producing router path"
    );
    submeshes.sub_meshes[0].uvs.as_mut().unwrap().truncate(2);
    let mut hasher = Some(GeometryHasher::new(1e-5, [0.; 3]));
    let (split, occurrences) = super::presentation_source::submeshes(
        &AssemblyJob::from(&job),
        submeshes,
        [0.8; 4],
        &ctx,
        &mut decoder,
        &mut hasher,
        0,
        Some(&context),
    );
    assert!(occurrences.is_empty());
    assert_eq!(split.len(), 2);
    assert_eq!(
        split.iter().map(|mesh| mesh.color).collect::<Vec<_>>(),
        [[1., 0., 0., 1.], [0., 1., 0., 1.]]
    );
    assert_eq!(
        split.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
        12
    );
    assert!(split
        .iter()
        .all(|mesh| mesh.texture.is_none() && mesh.uvs.is_none()));
    assert!(split
        .iter()
        .all(|mesh| mesh.geometry_item_id == Some(13) && mesh.material_id.is_none()));
    assert!(!hasher.as_ref().unwrap().is_empty());
    let mut merged = router
        .process_element_parts(&entity, &mut decoder)
        .unwrap()
        .remove(0);
    merged.indices.truncate(9); // stated invariant: topology changed after source colour indexing
    let fallback = super::presentation_source::fallback(
        &AssemblyJob::from(&job),
        &entity,
        merged,
        [0.8; 4],
        &ctx,
        &mut decoder,
        &mut None,
        Some(&context),
    );
    assert_eq!(fallback.len(), 1);
    assert_eq!(fallback[0].color, [0.8; 4]);
    assert_eq!(
        fallback[0].geometry_item_id, None,
        "rejected palette cannot leak its source identity"
    );
    assert!(fallback[0].texture.is_none());
}

#[test]
fn presentation_fallback_palette_uses_source_map_geometry_id_and_shared_buffers_after_owner_drop() {
    let source = source();
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_units(&source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let mut inputs = data(&source, &mut decoder);
    // Malformed but historically accepted map key != embedded geometry_id.
    Arc::make_mut(&mut inputs.indexed_colour_full)
        .get_mut(&13)
        .unwrap()
        .geometry_id = 777;
    let context = ProductionModel::new().snapshot(inputs);
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let mesh = router
        .process_element_parts(&entity, &mut decoder)
        .unwrap()
        .remove(0);
    let mut hasher = Some(GeometryHasher::new(1e-5, [0.; 3]));
    let split = super::presentation_source::fallback(
        &AssemblyJob::from(&job),
        &entity,
        mesh,
        [0.8; 4],
        &context.borrowed(),
        &mut decoder,
        &mut hasher,
        Some(&context),
    );
    assert_eq!(split.len(), 2);
    assert!(split.iter().all(|mesh| mesh.geometry_item_id == Some(777)));
    assert!(split.iter().all(|mesh| mesh.material_id.is_none()));
    assert_eq!(
        split.iter().map(|mesh| mesh.indices.len()).sum::<usize>(),
        12
    );
    assert!(hasher.as_ref().unwrap().volume().unwrap() > 0.16);
    let palette = super::presentation::Palette::admitted(
        13,
        context.borrowed().indexed_colour_full,
        Some(&context),
    );
    // Move the owned variant out of the borrowed admission view, exactly as an
    // owned runtime resource; it retains the same map allocation, not a copy.
    let super::presentation::Palette::Shared {
        maps: retained,
        key,
    } = palette
    else {
        panic!("owned palette")
    };
    assert!(Arc::ptr_eq(&retained, &context.presentation_palettes()));
    drop(context);
    drop(decoder);
    drop(router);
    drop(source);
    assert_eq!(
        retained[&key].geometry_id,
        777
    );
}

#[test]
fn presentation_owned_packet_assembles_after_actual_decoder_router_source_and_job_drop() {
    use super::presentation::{assemble, PresentationFrame, ReadyPresentation};
    let (packet, expected, model, rotation_lifetime) = {
        let source = source();
        let mut decoder = EntityDecoder::new(&source);
        let router = GeometryRouter::with_units(&source, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        let mut inputs = data(&source, &mut decoder);
        inputs.geometry_style_index = Arc::new(
            [(13, GeometryStyleInfo::from_color([0.2, 0.4, 0.7, 1.]))]
                .into_iter()
                .collect(),
        );
        let rotation = Arc::new(vec![
            0., -1., 0., 0., 1., 0., 0., 0.,
            0., 0., 1., 0., 0., 0., 0., 1.,
        ]);
        let rotation_lifetime = Arc::downgrade(&rotation);
        inputs.site_local_rotation = Some(rotation);
        let context = ProductionModel::new().snapshot(inputs);
        let entity = decoder.decode_by_id(60).unwrap();
        let meta = metadata(60);
        let input = ElementMeshJob {
            kind: ElementJobKind::TypeProduct {
                rep_maps: vec![(61, 2)],
            },
            ..job(&entity, &meta)
        };
        let expected =
            produce_element_meshes_owned(&input, &context, &options(), &mut decoder, &router)
                .unwrap();
        let map = decoder.decode_by_id(61).unwrap();
        let mut parts = router
            .process_representation_map_with_texture(
                &map,
                &mut decoder,
                context.borrowed().texture_index,
            )
            .unwrap();
        assert_eq!(parts.len(), 1);
        let color = resolve_color_for_representation_map(
            61,
            context.borrowed().geometry_style_index,
            &mut decoder,
        )
        .unwrap();
        let (mesh, uvs, texture) = parts.remove(0);
        let owned_job = super::session_state::OwnedJob::new(&input);
        let model = Arc::downgrade(&context);
        let packet: ReadyPresentation<'static> = ReadyPresentation {
            job: owned_job.assembly(),
            frame: PresentationFrame::Shared(context.presentation_rotation()),
            part: super::assembly_types::ready_type_part(mesh, uvs, texture, color, 2),
        };
        (packet, expected, model, rotation_lifetime)
    }; // source storage, decoder, router, original job and metadata are gone
    assert!(model.upgrade().is_none(), "numerical packet must not retain model/source authority");
    assert!(rotation_lifetime.upgrade().is_some(), "derived rotation survives its model");
    let (meshes, occurrence) = assemble(packet, &mut None);
    assert!(rotation_lifetime.upgrade().is_none(), "assembly releases its rotation handle");
    assert!(occurrence.is_none());
    assert_eq!(meshes.len(), 1);
    let actual = &meshes[0];
    assert!(actual.positions.chunks_exact(3).any(|p| p[0] < -0.5 || p[1] < -0.5),
        "nonidentity site rotation must affect the actual textured geometry");
    let expected = &expected.meshes[0];
    assert_eq!(actual.positions, expected.positions);
    assert_eq!(actual.indices, expected.indices);
    assert_eq!(actual.normals, expected.normals);
    assert_eq!(actual.origin, expected.origin);
    assert_eq!(actual.local_bounds, expected.local_bounds);
    assert_eq!(actual.local_to_world, expected.local_to_world);
    assert_eq!(actual.color, expected.color);
    assert_eq!(actual.properties, expected.properties);
    assert_eq!(actual.global_id, expected.global_id);
    assert_eq!(actual.name, expected.name);
    assert_eq!(actual.presentation_layer, expected.presentation_layer);
    assert_eq!(actual.geometry_class, expected.geometry_class);
    assert_eq!(actual.uvs, expected.uvs);
    assert_eq!(
        actual.texture.as_ref().unwrap().url,
        expected.texture.as_ref().unwrap().url
    );
}
