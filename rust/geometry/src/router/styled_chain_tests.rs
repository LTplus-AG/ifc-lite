// SPDX-License-Identifier: MPL-2.0
//! #10698: each styled sub-mesh carries the `IfcMappedItem` occurrences it was
//! produced under (`StyledSubMeshes`), paired with it through nesting, a
//! don't-bake placeholder and a void cut, and the plain entry's output is the
//! styled entry's without the chains.
use crate::{AccountedMappedItemCache, GeometryRouter, RouterConfig};
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Block #10 in map #12, mapped by #13 (identity) and #15 (moved 10 in x).
/// Map #21's items are block #16, the nested mapped item #13 and block #17,
/// and #22 maps it. Product #30's body maps #21 through #22.
const NESTED: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,2.,3.);\
    #11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#12=IFCREPRESENTATIONMAP(#2,#11);\
    #13=IFCMAPPEDITEM(#12,#3);#14=IFCCARTESIANPOINT((10.,0.,0.));\
    #4=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);#15=IFCMAPPEDITEM(#12,#4);\
    #5=IFCCARTESIANPOINT((0.,0.,5.));#6=IFCAXIS2PLACEMENT3D(#5,$,$);\
    #16=IFCBLOCK(#6,4.,4.,4.);#17=IFCBLOCK(#2,7.,1.,1.);\
    #20=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#16,#13,#17));\
    #21=IFCREPRESENTATIONMAP(#2,#20);#22=IFCMAPPEDITEM(#21,#4);\
    #23=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#22));\
    #24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));#30=IFCBUILDINGELEMENTPROXY('nested',$,$,$,$,$,#24,$,$);\
    #25=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#15));\
    #26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));#31=IFCBUILDINGELEMENTPROXY('placed',$,$,$,$,$,#26,$,$);\
    #27=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#13));\
    #28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));#32=IFCBUILDINGELEMENTPROXY('template',$,$,$,$,$,#28,$,$);";

/// Wall #10's body is mapped item #40 over a map holding extrusion #7; opening
/// #21 cuts it.
const VOIDED: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCDIRECTION((0.,0.,1.));#5=IFCCARTESIANPOINT((0.,0.));#6=IFCAXIS2PLACEMENT2D(#5,$);\
    #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,10.,1.);#7=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);\
    #8=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7));#41=IFCREPRESENTATIONMAP(#2,#8);\
    #42=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#40=IFCMAPPEDITEM(#41,#42);\
    #43=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#40));#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));\
    #10=IFCWALL('host',$,$,$,$,$,#9,$);#30=IFCCARTESIANPOINT((0.,-1.,0.5));\
    #31=IFCAXIS2PLACEMENT3D(#30,$,$);#32=IFCBLOCK(#31,1.,2.,1.);\
    #33=IFCSHAPEREPRESENTATION($,'Body','CSG',(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));\
    #21=IFCOPENINGELEMENT('block',$,$,$,$,$,#34,$);";

fn chains(styled: &crate::StyledSubMeshes) -> Vec<(u32, Vec<u32>)> {
    styled.iter().map(|(sub, chain)| (sub.geometry_id, chain.to_vec())).collect()
}

#[test]
fn nested_occurrences_are_recorded_inner_to_outer() {
    let mut decoder = EntityDecoder::new(NESTED);
    let product = decoder.decode_by_id(30).unwrap();
    let router = GeometryRouter::new();
    let styled = router.process_element_with_styled_submeshes_textured(&product, &mut decoder, &FxHashMap::default()).unwrap();
    assert_eq!(chains(&styled), [(16, vec![22]), (10, vec![13, 22]), (17, vec![22])]);
    let plain = GeometryRouter::new().process_element_with_submeshes(&product, &mut decoder).unwrap();
    let projected = styled.into_collection();
    assert_eq!(projected.sub_meshes.len(), plain.sub_meshes.len());
    for (a, b) in projected.sub_meshes.iter().zip(&plain.sub_meshes) {
        assert_eq!((a.geometry_id, &a.mesh.positions, &a.mesh.indices), (b.geometry_id, &b.mesh.positions, &b.mesh.indices));
    }
}

#[test]
fn a_dont_bake_placeholder_and_its_template_carry_their_own_occurrence() {
    let mut decoder = EntityDecoder::new(NESTED);
    let mut router = GeometryRouter::from_config(RouterConfig::default());
    router.enable_accounted_mapped_item_cache(AccountedMappedItemCache::new());
    router.enable_output_instancing(Arc::new([(12, (2, 13))].into_iter().collect()));
    let placed = decoder.decode_by_id(31).unwrap();
    let placeholder = router.process_element_with_styled_submeshes_textured(&placed, &mut decoder, &FxHashMap::default()).unwrap();
    let [(sub, chain)] = placeholder.iter().collect::<Vec<_>>()[..] else { panic!("one placeholder") };
    assert!(sub.mesh.positions.is_empty(), "a don't-bake placeholder");
    assert_eq!((sub.geometry_id, chain), (10, &[15][..]));
    let template = decoder.decode_by_id(32).unwrap();
    let template = router.process_element_with_styled_submeshes_textured(&template, &mut decoder, &FxHashMap::default()).unwrap();
    assert_eq!(chains(&template), [(10, vec![13])]);
}

#[test]
fn a_cut_part_keeps_its_occurrence() {
    let mut decoder = EntityDecoder::new(VOIDED);
    let host = decoder.decode_by_id(10).unwrap();
    let void_index = [(10, vec![21])].into_iter().collect();
    let router = GeometryRouter::new();
    let cut = router.process_element_with_styled_submeshes_and_voids(&host, &mut decoder, &void_index).unwrap();
    let [(sub, chain)] = cut.iter().collect::<Vec<_>>()[..] else { panic!("one cut part") };
    assert!(sub.mesh.triangle_count() > 12, "the opening was cut");
    assert_eq!((sub.geometry_id, chain), (7, &[40][..]));
}
