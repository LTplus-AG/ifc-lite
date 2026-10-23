// SPDX-License-Identifier: MPL-2.0
//! #7781: an admitted prefix retains its complete payload across execution paths.
use super::*;
use crate::processors::texture::{ImageTextureRef, ResolvedTextureMap, TextureSource};
use crate::profile_walk_model as model;
use std::sync::Arc;

fn assert_mesh(a: &Mesh, b: &Mesh) {
    assert_eq!(a.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), b.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
    assert_eq!(a.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), b.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
    assert_eq!(a.indices, b.indices);
    assert_eq!(a.origin.map(f64::to_bits), b.origin.map(f64::to_bits));
    assert_eq!(a.rtc_applied, b.rtc_applied);
    assert_eq!(a.welded_in_object_frame, b.welded_in_object_frame);
    assert_eq!(a.local_bounds.map(|v| v.map(f32::to_bits)), b.local_bounds.map(|v| v.map(f32::to_bits)));
    assert_eq!(a.local_to_world.map(|v| v.map(f64::to_bits)), b.local_to_world.map(|v| v.map(f64::to_bits)));
    let instance = |m: &Mesh| m.instance_meta.as_ref().map(|v| (v.transform.map(f64::to_bits),
        v.local_transform.map(|v| v.map(f64::to_bits)), v.canonical_transform.map(|v| v.map(f64::to_bits)),
        v.rep_identity, v.instanceable));
    assert_eq!(instance(a), instance(b));
    let planes = |m: &Mesh| m.plane_tags.as_ref().map(|v| v.iter()
        .map(|p| (p.n.map(f64::to_bits), p.d.to_bits())).collect::<Vec<_>>());
    assert_eq!(planes(a), planes(b));
}

fn assert_payload(a: &SubMeshCollection, b: &SubMeshCollection) {
    assert_eq!(a.ids_are_materials, b.ids_are_materials);
    assert_eq!(a.sub_meshes.len(), b.sub_meshes.len());
    for (a, b) in a.sub_meshes.iter().zip(&b.sub_meshes) {
        assert_eq!(a.geometry_id, b.geometry_id);
        assert_mesh(&a.mesh, &b.mesh);
        let uv = |s: &crate::SubMesh| s.uvs.as_ref().map(|v| v.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        assert_eq!(uv(a), uv(b));
        match (&a.texture, &b.texture) {
            (None, None) => {},
            (Some(a), Some(b)) => {
                assert_eq!(a.texture_id, b.texture_id);
                let (TextureSource::Image(a), TextureSource::Image(b)) = (&a.source, &b.source)
                    else { panic!("fixture uses image textures") };
                assert_eq!((&a.url, a.repeat_s, a.repeat_t), (&b.url, b.repeat_s, b.repeat_t));
            }
            _ => panic!("texture presence changed"),
        }
    }
}

fn execute(router: &GeometryRouter, decoder: &mut EntityDecoder, wall: &DecodedEntity,
    textures: &FxHashMap<u32, ResolvedTextureMap>, allowance: u32, stepped: bool) -> SubMeshCollection {
    let mut control = ProductControl::styled(wall, true, Some(textures), SourceHygiene::Watertight);
    control.allowance = allowance;
    if stepped {
        while control.stage().unwrap().is_some() {
            let reply = control.execute(router, decoder).unwrap();
            control.accept(reply, router);
        }
    } else { control.run(router, decoder).unwrap(); }
    let ProductOutput::Styled(output) = control.take_result().unwrap().unwrap()
        else { panic!("styled output") };
    output
}

fn configured_router(mode: u8) -> GeometryRouter {
    let mut router = GeometryRouter::new();
    router.enable_accounted_mapped_item_cache(crate::AccountedMappedItemCache::new());
    if mode != 0 {
        let template = if mode == 1 { 1000 } else { 9999 };
        router.enable_output_instancing(Arc::new([(1001, (2, template))].into_iter().collect()));
        router.set_instancing_batch_local(false);
    }
    router
}

#[test]
fn issue_7781_textured_template_and_placeholder_prefix_payloads_survive_later_refusal() {
    // 0: textured face; 1: materialized instancing template; 2: placeholder.
    for mode in 0..3 {
        let first = if mode == 0 { 900 } else { 1000 };
        let content = model::wall("#160", &format!(
            "{}\n{}\n{}\n#899=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));\n\
             #900=IFCTRIANGULATEDFACESET(#899,$,.F.,((1,2,3)),$);\n\
             #160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#{first},#2000,#240));",
            model::TARGET, model::mapped(1000, "#140"), model::mapped(2000, "#240")));
        let textures = if mode == 0 {
            [(900, ResolvedTextureMap { texture_id: 950,
                texture: TextureSource::Image(ImageTextureRef { url: "fixture.png".into(), repeat_s: true, repeat_t: false }),
                tex_coords: vec![[0., 0.], [1., 0.], [0., 1.]], tex_coord_index: None })].into_iter().collect()
        } else { FxHashMap::default() };
        let allowance = if mode == 0 { 3 } else { 4 };
        let mut expected = None;
        for warm in [false, true] {
            for stepped in [false, true] {
                let mut decoder = EntityDecoder::new(&content);
                let mut router = configured_router(mode);
                let wall = decoder.decode_by_id(100).unwrap();
                let full = execute(&router, &mut decoder, &wall, &textures,
                    crate::representation::MAX_WALK_LEVELS, stepped);
                assert_eq!(full.sub_meshes.len(), 3);
                assert!(router.take_unsupported_items().is_empty());
                // Cold comparison uses a fresh router/decoder below; full is
                // an independent accepted-output control for the prefix.
                if !warm {
                    decoder = EntityDecoder::new(&content);
                    router = configured_router(mode);
                }
                let output = execute(&router, &mut decoder, &wall, &textures, allowance, stepped);
                assert_eq!(output.sub_meshes.len(), 1);
                assert_eq!(router.take_unsupported_items().values().sum::<u64>(), 1);
                let first = &output.sub_meshes[0];
                assert_eq!(first.geometry_id, if mode == 0 { 900 } else { 140 });
                if mode == 0 {
                    assert_eq!(first.mesh.indices.len(), 3);
                    assert!(first.uvs.is_some() && first.texture.is_some());
                } else {
                    assert_eq!(first.mesh.positions.is_empty(), mode == 2);
                    let meta = first.mesh.instance_meta.as_ref().unwrap();
                    assert_eq!(meta.rep_identity, 1001);
                    assert!(meta.instanceable);
                }
                let prefix = SubMeshCollection { sub_meshes: vec![full.sub_meshes[0].clone()], ids_are_materials: full.ids_are_materials };
                assert_payload(&output, &prefix);
                if let Some(expected) = &expected { assert_payload(&output, expected); }
                else { expected = Some(output); }
            }
        }
    }
}
