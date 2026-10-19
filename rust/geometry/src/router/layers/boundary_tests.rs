// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Staged real-host layer boundaries and consuming diagnostic publication.
use super::stages::{LayerProgram, LayerSkip};
use crate::material_layer_index::{LayerAxis, LayerBuildup, LayerInfo};
use crate::{GeometryRouter, Mesh};
use ifc_lite_core::EntityDecoder;
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

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
        layers: vec![
            LayerInfo {
                material_id: 100,
                thickness: 0.15,
            },
            LayerInfo {
                material_id: 101,
                thickness: 0.15,
            },
        ],
        axis: LayerAxis::Axis2,
        direction_sense: 1.,
        offset_from_reference_line: -0.15,
    }
}

#[test]
fn layer_host_empty_gate_precedes_unreadable_placement() {
    let source = WALL.replace("$,#3,#8", "$,#999,#8");
    let mut decoder = EntityDecoder::new(&source);
    let element = decoder.decode_by_id(9).unwrap();
    let program = LayerProgram::admit(&element, &mut decoder, &buildup(), 1.)
        .ok()
        .flatten()
        .unwrap();
    assert!(matches!(
        program.accept_host(Mesh::new()),
        Err(LayerSkip::EmptyHost)
    ));
    assert!(decoder.get_cached(999).is_none());
}

#[test]
fn layer_frame_observes_placement_mutation_after_actual_host() {
    let mut decoder = EntityDecoder::new(WALL);
    let element = decoder.decode_by_id(9).unwrap();
    let router = GeometryRouter::new();
    let program = LayerProgram::admit(&element, &mut decoder, &buildup(), 1.)
        .ok()
        .flatten()
        .unwrap();
    let host = router
        .process_element_with_voids(&element, &mut decoder, &FxHashMap::default())
        .unwrap();
    let request = program.accept_host(host).ok().unwrap();
    // A host extension can update the canonical placement cache. The frame
    // admission must observe this write, rather than an earlier eligibility read.
    let mut placement = Matrix4::identity();
    placement[(1, 3)] = 10.;
    decoder.cache_placement_transform(3, crate::math::mat4::col_major_array(&placement));
    let planes = request
        .admit_frame(&element, &mut decoder, &router)
        .ok()
        .unwrap();
    let ready = planes.execute().ok().unwrap();
    assert_eq!(ready.planes.len(), 1);
    assert!((ready.planes[0].point.y - 10.).abs() < 1e-12);
}

#[test]
fn layer_numerical_slice_owns_unpublished_result_after_source_disposal() {
    let router = GeometryRouter::new();
    let ready = {
        let mut decoder = EntityDecoder::new(WALL);
        let element = decoder.decode_by_id(9).unwrap();
        let program = LayerProgram::admit(&element, &mut decoder, &buildup(), 1.)
            .ok()
            .flatten()
            .unwrap();
        let host = router
            .process_element_with_voids(&element, &mut decoder, &FxHashMap::default())
            .unwrap();
        program
            .accept_host(host)
            .ok()
            .unwrap()
            .admit_frame(&element, &mut decoder, &router)
            .ok()
            .unwrap()
            .execute()
            .ok()
            .unwrap()
    };
    let reply = ready.execute();
    assert!(
        router.take_layer_slice_diag().is_empty(),
        "execution does not publish accept-time effects"
    );
    let collection = reply.publish(&router, 9);
    assert_eq!(collection.sub_meshes.len(), 2);
    assert!(collection.ids_are_materials);
    assert_eq!(
        collection
            .sub_meshes
            .iter()
            .map(|sub| sub.geometry_id)
            .collect::<Vec<_>>(),
        [100, 101]
    );
    assert_eq!(router.take_layer_slice_diag(), [(9, "ok:sliced")]);
}

#[test]
fn layer_stages_are_send() {
    fn send<T: Send>() {}
    send::<LayerProgram>();
    send::<super::stages::LayerPlaneRequest>();
    send::<super::stages::ReadyLayerPlanes>();
    send::<super::stages::ReadyLayerSlice>();
    send::<super::stages::LayerSliceResult>();
}
