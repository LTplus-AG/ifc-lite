// SPDX-License-Identifier: MPL-2.0
//! #7955 CUT-0: real logical admissions, no kernel substitution.
use super::*;
fn host() -> LogicalRetainedValue {
    use crate::program::inner::retained_program::RetainedProgram;
    let bytes=b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);
#7=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));
#10=IFCWALL('w',$,$,$,$,$,#8,$,$);ENDSEC;END-ISO-10303-21;";
    let source=ifc_lite_core::SourceBundle::new(bytes.to_vec()); let mut decoder=source.decoder();
    let router=crate::GeometryRouter::new(); let wall=decoder.decode_by_id(10).unwrap();
    let mut program=RetainedProgram::product_parts(&wall,RetainedContract { source_epoch:7,source_revision:9 });
    while let Some(ticket)=program.request().unwrap() {
        let (reply,_)=program.admit(ticket,&router,&mut decoder).unwrap();
        program.accept(reply,&router).unwrap_or_else(|e|panic!("{:?}",e.error));
    }
    program.finish().unwrap().values.pop().unwrap()
}
#[test]
fn cut0_plane_box_skip_padding_and_source_frame_are_consistent() {
    let host=host(); let bounds=host.bounds.unwrap();
    assert!(matches!(halfspace_box(&host,77,[0.,0.,4.],[0.,0.,1.]).unwrap(),CutterStep::Skip));
    let CutterStep::Cutter(op)=halfspace_box(&host,77,[0.,0.,1.],[0.,0.,1.]).unwrap() else { panic!("missing cutter") };
    let RetainedOperationKind::Construction(RetainedRecipe::Prism(p))=op.kind() else { panic!("missing prism") };
    assert_eq!(p.source_id,77); assert!(p.depth>2.);
    let cutter=Matrix4::from_column_slice(&p.frame); let inverse=cutter.try_inverse().unwrap();
    let b=op.value.bounds.unwrap().0;
    for point in bounds.corners() {
        let local=inverse.transform_point(&nalgebra::Point3::from(point));
        assert!(local.x>b[0] && local.x<b[3] && local.y>b[1] && local.y<b[4]);
        assert!(local.z<b[5]);
    }
    assert_eq!(p.frame[14],1.);
    assert_eq!(op.value.slot.program,host.slot.program); assert_ne!(op.value.slot,host.slot);
    assert_eq!(op.value.source_from_evaluation,crate::math::mat4::col_major_array(&Matrix4::identity()));
}
#[test]
fn cut0_placements_leave_bounds_local_and_affine_bake_maps_all_corners() {
    let mut host=host(); let original=host.bounds.unwrap();
    let transform=Matrix4::new_translation(&Vector3::new(10.,20.,30.))*Matrix4::new_nonuniform_scaling(&Vector3::new(2.,3.,4.));
    host.place_in_place(&transform,host.slot.program,RetainedPlacementStage::Mapping { source_id:99 }).unwrap();
    assert_eq!(host.bounds,Some(original));
    let frame=host.world_from_evaluation(); let baked=host.bake().unwrap().unwrap();
    let expected=bounds::EvaluationBounds::points(original.corners().map(|p| frame.transform_point(&nalgebra::Point3::from(p)).into())).unwrap();
    assert_eq!(baked.value.bounds,Some(expected)); assert_eq!(host.bounds,Some(expected));
    assert_eq!(host.object_frame,crate::math::mat4::col_major_array(&Matrix4::identity()));
}
