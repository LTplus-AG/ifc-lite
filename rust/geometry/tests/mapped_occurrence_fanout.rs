// SPDX-License-Identifier: MPL-2.0
//! Accumulating DAG edges denote real occurrences. This deliberately modest
//! depth demonstrates expansion without exercising an unsafe resource limit;
//! the current depth/path guards do not bound its exponential output growth.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

#[test]
fn acyclic_repeated_map_edges_preserve_every_geometric_occurrence() {
    let mut source = String::from("#1=IFCCARTESIANPOINT((0.,0.,0.));
        #2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);
        #4=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#10=IFCBLOCK(#2,1.,1.,1.);
        #11=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
        #12=IFCREPRESENTATIONMAP(#2,#11);#13=IFCMAPPEDITEM(#12,#4);");
    let mut previous = 13;
    for level in 0..8 {
        let representation = 100 + 3*level;
        let map = representation + 1;
        let item = representation + 2;
        source.push_str(&format!("#{representation}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{previous},#{previous}));
            #{map}=IFCREPRESENTATIONMAP(#2,#{representation});#{item}=IFCMAPPEDITEM(#{map},#4);"));
        previous = item;
    }
    source.push_str(&format!("#900=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{previous}));
        #901=IFCPRODUCTDEFINITIONSHAPE($,$,(#900));
        #902=IFCBUILDINGELEMENTPROXY('fanout-derived',$,'Controlled accumulating DAG',$,$,#3,#901,$,$);"));
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_scale_and_local_frame(1., false);
    let product = decoder.decode_by_id(902).unwrap();
    let styled = router.process_element_with_submeshes(&product, &mut decoder).unwrap();
    assert_eq!(styled.len(), 1 << 8, "path membership cannot deduplicate repeated DAG occurrences");
    assert!(styled.sub_meshes.iter().all(|sub| sub.geometry_id == 10 && sub.mesh.indices.len() == 36));
    let merged = router.process_element_parts(&product, &mut decoder).unwrap();
    assert_eq!(merged.iter().map(|mesh| mesh.indices.len()/3).sum::<usize>(), 12*(1 << 8),
        "source caching may reuse construction but must retain the same accumulated geometry");
}
