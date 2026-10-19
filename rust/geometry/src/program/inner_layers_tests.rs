// SPDX-License-Identifier: MPL-2.0
//! Paused common layer root over its actual canonical host child.
use super::*;
use crate::material_layer_index::{LayerAxis, LayerInfo};

const WALL: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.3);
#5=IFCDIRECTION((0.,0.,1.));
#6=IFCEXTRUDEDAREASOLID(#4,#2,#5,3.);
#7=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6));
#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));
#9=IFCWALL('wall',$,$,$,$,#3,#8,$,$);";

fn buildup() -> LayerBuildup {
    LayerBuildup::Sliceable {
        layers: vec![LayerInfo { material_id: 100, thickness: 0.15 },
            LayerInfo { material_id: 101, thickness: 0.15 }],
        axis: LayerAxis::Axis2, direction_sense: 1., offset_from_reference_line: -0.15,
    }
}

#[test]
fn common_layer_frame_admission_observes_mutation_after_actual_host_child() {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(WALL);
    let element = decoder.decode_by_id(9).unwrap();
    let mut control = LayerControl::from_buildup(element, buildup());
    let mut late_frame = false;
    while control.poll().unwrap().is_some() {
        if matches!(control.action, Some(Action::Frame(_))) {
            assert!(!late_frame);
            late_frame = true;
            let mut transform = nalgebra::Matrix4::identity();
            transform[(1, 3)] = 10.;
            decoder.cache_placement_transform(3, crate::math::mat4::col_major_array(&transform));
        }
        let reply = if let Some(ready) = control.take_ready() {
            let predicted = ready.tag();
            let reply = ready.execute();
            assert_eq!(reply.tag(), predicted, "late plane/slice/cleanup keeps its predicted reply kind");
            reply
        } else { control.execute(&router, &mut decoder, None, None).unwrap() };
        control.accept(reply, &router);
    }
    assert!(late_frame, "the nonempty canonical host opens the late frame gate");
    let GeometryOutput::LayerCandidate(Some(collection)) = control.take_output().unwrap().unwrap()
        else { panic!("direct layer mode retains its successful single-band candidate") };
    assert_eq!(collection.sub_meshes.len(), 1, "late shifted plane misses the previously built host");
    assert_eq!(collection.sub_meshes[0].geometry_id, 100);
    assert_eq!(router.take_layer_slice_diag(), [(9, "skip:cut-produced-<2")]);
}

#[test]
fn absent_layer_index_skips_unreadable_representation_without_host_work() {
    let source = "#9=IFCWALL('wall',$,$,$,$,#998,#999,$,$);";
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(9).unwrap();
    let router = GeometryRouter::new();
    let mut control = LayerControl::from_index(element, false);
    assert!(control.poll().unwrap().is_some());
    let reply = control.execute(&router, &mut decoder, None, None).unwrap();
    control.accept(reply, &router);
    assert!(control.poll().unwrap().is_none());
    assert!(matches!(control.take_output().unwrap().unwrap(), GeometryOutput::LayerCandidate(None)));
    assert!(decoder.get_cached(998).is_none());
    assert!(decoder.get_cached(999).is_none());
    assert!(router.take_layer_slice_diag().is_empty());
}

#[test]
fn common_layer_suspension_and_linear_reply_are_send() {
    fn send<T: Send>() {}
    send::<LayerControl>(); send::<LayerReply>(); send::<LayerReadyWork>();
}
