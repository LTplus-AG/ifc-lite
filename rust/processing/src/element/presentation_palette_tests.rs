// SPDX-License-Identifier: MPL-2.0
//! Presentation palette/UV invariants on a real meshed STEP tetrahedron.
use super::presentation_tests::{job, metadata, options, Data, SOURCE};
use super::*;

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
fn data(source: &str, decoder: &mut EntityDecoder) -> Data {
    let full =
        crate::style::resolve_indexed_colour_map_full(&decoder.decode_by_id(211).unwrap(), decoder).unwrap();
    Data {
        palettes: [(13, full)].into_iter().collect(),
        textures: ifc_lite_geometry::build_texture_index(source.as_bytes(), decoder),
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
    inputs.styles = [(13, GeometryStyleInfo::from_color(color))].into_iter().collect();
    for types in [false, true] {
        let entity = decoder.decode_by_id(if types { 60 } else { 10 }).unwrap();
        let meta = metadata(entity.id);
        let mut input = job(&entity, &meta);
        if types {
            input.kind = ElementJobKind::TypeProduct { rep_maps: vec![(61, 2)] };
        }
        let result = produce_element_meshes(&input, &inputs.ctx(), &options(), &mut decoder, &router);
        assert_eq!(result.meshes.len(), 1, "valid texture wins over the two-colour palette");
        let mesh = &result.meshes[0];
        assert_eq!(mesh.color, color);
        assert_eq!(mesh.texture.as_ref().unwrap().url.as_deref(), Some("textures/tetra.png"));
        assert_eq!(mesh.uvs.as_ref().unwrap().len(), mesh.positions.len() / 3 * 2);
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
    let ctx = inputs.ctx();
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let mut submeshes = router
        .process_element_with_submeshes_textured(&entity, &mut decoder, ctx.texture_index)
        .unwrap();
    assert_eq!(submeshes.len(), 1);
    assert!(submeshes.sub_meshes[0].texture.is_some(), "actual texture-producing router path");
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
    );
    assert!(occurrences.is_empty());
    assert_eq!(split.iter().map(|m| m.color).collect::<Vec<_>>(), [[1., 0., 0., 1.], [0., 1., 0., 1.]]);
    assert_eq!(split.iter().map(|m| m.indices.len()).sum::<usize>(), 12);
    assert!(split.iter().all(|m| m.texture.is_none() && m.uvs.is_none()));
    assert!(split.iter().all(|m| m.geometry_item_id == Some(13) && m.material_id.is_none()));
    assert!(!hasher.as_ref().unwrap().is_empty());
    let mut merged = router.process_element_parts(&entity, &mut decoder).unwrap().remove(0);
    merged.indices.truncate(9); // stated invariant: topology changed after source colour indexing
    let fallback = super::presentation_source::fallback(
        &AssemblyJob::from(&job),
        &entity,
        merged,
        [0.8; 4],
        &ctx,
        &mut decoder,
        &mut None,
    );
    assert_eq!(fallback.len(), 1);
    assert_eq!(fallback[0].color, [0.8; 4]);
    assert_eq!(fallback[0].geometry_item_id, None, "rejected palette cannot leak its source identity");
    assert!(fallback[0].texture.is_none());
}

#[test]
fn presentation_fallback_palette_uses_source_map_geometry_id_and_hashes_the_unsplit_body() {
    let source = source();
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_units(&source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let mut inputs = data(&source, &mut decoder);
    // Malformed but historically accepted: map key != embedded geometry_id.
    inputs.palettes.get_mut(&13).unwrap().geometry_id = 777;
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let mesh = router.process_element_parts(&entity, &mut decoder).unwrap().remove(0);
    let mut hasher = Some(GeometryHasher::new(1e-5, [0.; 3]));
    let split = super::presentation_source::fallback(
        &AssemblyJob::from(&job),
        &entity,
        mesh,
        [0.8; 4],
        &inputs.ctx(),
        &mut decoder,
        &mut hasher,
    );
    assert_eq!(split.len(), 2);
    assert!(split.iter().all(|m| m.geometry_item_id == Some(777) && m.material_id.is_none()));
    assert_eq!(split.iter().map(|m| m.indices.len()).sum::<usize>(), 12);
    assert!(hasher.as_ref().unwrap().volume().unwrap() > 0.16);
}
