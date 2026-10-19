// SPDX-License-Identifier: MPL-2.0
//! P1 positive exact palette/UV channels use actual decoded IFC and production assembly.
use super::*;
use super::super::session_tests::{job,metadata};
use super::super::{OwnedMeshProductionData,ProductionModel};
use ifc_lite_core::SourceBundle;

#[test]
fn p1_exact_repeated_styled_palette_and_texture_channels_reach_canonical_assembly() {
    const IFC:&str=include_str!("../../../../geometry/tests/fixtures/p1-styled-textured-maps.ifc");
    for textured in [false,true] {
        let model=ProductionModel::from_source(SourceBundle::new(IFC.as_bytes().to_vec()));
        let source=model.snapshot(OwnedMeshProductionData::default());
        let mut decoder=source.source().unwrap().decoder();
        let map=decoder.decode_by_id(51).unwrap();
        let palette=crate::style::resolve_indexed_colour_map_full(&map,&mut decoder).unwrap();
        assert_eq!(palette.triangle_palette,vec![0,1]);assert_eq!(palette.colours.len(),2);
        let palettes=[(5,palette)].into_iter().collect();
        let guard=crate::style::indexed_colour_split_guard_ids(&palettes).expect("two-colour palette guard");
        let textures=if textured {ifc_lite_geometry::build_texture_index(IFC.as_bytes(),&mut decoder)} else {Default::default()};
        let context=model.snapshot(OwnedMeshProductionData {indexed_colour_full:Arc::new(palettes),texture_index:Arc::new(textures),..Default::default()});
        let mut decoder=context.source().unwrap().decoder();decoder.seed_unit_scales(1.,1.);
        let mut router=GeometryRouter::with_scale(1.);
        router.enable_output_instancing(Arc::new([(7,(2,8))].into_iter().collect()));
        router.enable_indexed_colour_split_guard(guard);
        let entity=decoder.decode_by_id(10).unwrap();let metadata=metadata(10);
        let output=super::super::produce_element_meshes(&job(&entity,&metadata),&context.borrowed(),&MeshProductionOptions::default(),&mut decoder,&router);
        assert!(output.instance_occurrences.is_empty());
        assert_eq!(output.meshes.len(),if textured {2}else {4});
        assert_eq!(output.meshes.iter().map(|m|m.indices.len()/3).sum::<usize>(),4);
        assert!(output.meshes.iter().all(|mesh|mesh.geometry_item_id==Some(5)&&mesh.material_id.is_none()));
        if textured {
            assert!(output.meshes.iter().all(|mesh|mesh.uvs.as_ref().is_some_and(|uv|!uv.is_empty())&&mesh.texture.as_ref().is_some_and(|texture|texture.texture_id==41)));
        } else {
            for color in [[1.,0.,0.,1.],[0.,0.,1.,1.]] {assert_eq!(output.meshes.iter().filter(|m|m.color==color).count(),2);}
        }
    }
}
