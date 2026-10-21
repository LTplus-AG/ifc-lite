// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Staged real-host layer boundaries and consuming diagnostic publication.
use super::stages::LayerProgram;
use crate::material_layer_index::{LayerAxis, LayerBuildup, LayerInfo};
use crate::GeometryRouter;
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

/// Drives the real gateway (`process_element_with_material_layers`). An empty
/// host must be reported as `skip:empty-base-mesh`, never as a placement
/// problem; the control shows the identical element with a real profile is
/// sliced, so the empty-host diagnostic can only come from the empty gate.
#[test]
fn layer_gateway_reports_empty_host_without_slicing() {
    let run = |source: &str| {
        let mut decoder = EntityDecoder::new(source);
        let element = decoder.decode_by_id(9).unwrap();
        let router = GeometryRouter::new();
        let result = router
            .process_element_with_material_layers(
                &element,
                &mut decoder,
                &buildup(),
                &FxHashMap::default(),
            )
            .unwrap();
        (result, router.take_layer_slice_diag())
    };

    // Empty host: an arbitrary closed profile whose polyline has no points.
    let empty = WALL.replace(
        "#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,0.3);",
        "#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#11);\n#11=IFCPOLYLINE(());",
    );
    let (result, diag) = run(&empty);
    assert!(result.is_none());
    assert_eq!(diag, [(9, "skip:empty-base-mesh")]);

    // Control: the same element with a real profile slices.
    let (result, diag) = run(WALL);
    assert_eq!(result.unwrap().sub_meshes.len(), 2);
    assert_eq!(diag, [(9, "ok:sliced")]);
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
    let collection = reply.publish(&router, 9).unwrap();
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

#[test]
fn issue_7887_layer_gateway_admits_raw_items_before_probe_or_member_decode() {
    let cap = crate::representation::MAX_WALK_LEVELS as usize;
    // Ignored slots still consume the full raw list allowance. The first
    // referenced record would be rejected and counted if anyone decoded it.
    let items = format!("#90,{}", vec!["$"; cap].join(","));
    let source = format!("{}#90=IFCCARTESIANPOINT((1.E400,0.,0.));",
        WALL.replace("(#6)", &format!("({items})")));
    let mut decoder = EntityDecoder::new(&source).with_strict_reals();
    let element = decoder.decode_by_id(9).unwrap();
    let router = GeometryRouter::new();
    let result = router.process_element_with_material_layers(
        &element, &mut decoder, &buildup(), &FxHashMap::default(),
    ).unwrap();
    assert!(result.is_none(), "the ordinary caller must render only admitted roots");
    assert_eq!(decoder.refused_records(), 0, "no malformed member was probed");
    assert!(decoder.get_cached(90).is_none());
    assert!(decoder.get_cached(6).is_none());
    assert!(router.take_layer_slice_diag().is_empty(), "admission precedes layer eligibility diagnostics");
    assert!(router.take_unsupported_items().is_empty(), "source admission publishes no refusal");

    // The ordinary fallback now reports exactly one logical refusal, outside
    // any source-suppression scope, with the holding representation's type.
    let _scope = router.enter_unsupported_policy(false);
    assert!(router.process_element_with_submeshes(&element, &mut decoder).unwrap().is_empty());
    assert_eq!(router.take_unsupported_items().get("IfcShapeRepresentation"), Some(&1));
    assert_eq!(decoder.refused_records(), 0);
}

#[path = "terminal_tests.rs"]
mod terminal_tests;
