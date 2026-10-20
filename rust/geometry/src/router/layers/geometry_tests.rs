// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Independent shell-area/frame invariants for the layer gateway.
use crate::material_layer_index::{LayerAxis, LayerBuildup, LayerInfo};
use crate::{GeometryRouter, Mesh};
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;

fn wall(scale: f64, translation: [f64; 3], rotated: bool) -> String {
    let length = 4. / scale;
    let width = 0.3 / scale;
    let depth = 3. / scale;
    let [x, y, z] = translation.map(|v| v / scale);
    let reference = if rotated { "(0.,1.,0.)" } else { "(1.,0.,0.)" };
    format!(
        "DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#11);
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{length},{width});
#5=IFCDIRECTION((0.,0.,1.));
#6=IFCEXTRUDEDAREASOLID(#4,#2,#5,{depth});
#7=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#6));
#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));
#9=IFCWALL('wall',$,$,$,$,#3,#8,$,$);
#10=IFCCARTESIANPOINT(({x},{y},{z}));
#11=IFCAXIS2PLACEMENT3D(#10,$,#12);
#12=IFCDIRECTION({reference});
ENDSEC;"
    )
}

fn buildup(scale: f64) -> LayerBuildup {
    LayerBuildup::Sliceable {
        layers: vec![
            LayerInfo {
                material_id: 200,
                thickness: 0.05 / scale,
            },
            LayerInfo {
                material_id: 201,
                thickness: 0.2 / scale,
            },
            LayerInfo {
                material_id: 200,
                thickness: 0.05 / scale,
            },
        ],
        axis: LayerAxis::Axis2,
        direction_sense: 1.,
        offset_from_reference_line: -0.15 / scale,
    }
}

fn local_point(mesh: &Mesh, index: u32, rotated: bool) -> crate::Vector3<f64> {
    let i = index as usize * 3;
    let x = f64::from(mesh.positions[i]) + mesh.origin[0];
    let y = f64::from(mesh.positions[i + 1]) + mesh.origin[1];
    let z = f64::from(mesh.positions[i + 2]) + mesh.origin[2];
    // RTC equals the element translation. Undo the known quarter-turn only.
    if rotated {
        crate::Vector3::new(y, -x, z)
    } else {
        crate::Vector3::new(x, y, z)
    }
}

fn assert_partition(scale: f64, translation: [f64; 3], rotated: bool, opening: bool) {
    let mut content = wall(scale, translation, rotated);
    let mut voids = FxHashMap::default();
    if opening {
        // A unit square window passes through the wall thickness, between
        // heights one and two. The public layer driver must cut it BEFORE
        // partitioning the remaining outer shell.
        let size = 1. / scale;
        let through = 0.6 / scale;
        let [x, y, z] = translation.map(|v| v / scale);
        let z = z + size;
        let reference = if rotated { "(0.,1.,0.)" } else { "(1.,0.,0.)" };
        let records = format!(
            "
#20=IFCCARTESIANPOINT(({x},{y},{z}));
#21=IFCDIRECTION({reference});
#23=IFCAXIS2PLACEMENT3D(#20,$,#21);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,{size},{through});
#26=IFCEXTRUDEDAREASOLID(#25,#2,#5,{size});
#29=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#29));
#31=IFCOPENINGELEMENT('opening',$,$,$,$,#24,#30,$,$);
ENDSEC;"
        );
        content = content.replace("ENDSEC;", &records);
        voids.insert(9, vec![31]);
    }
    let mut decoder = EntityDecoder::new(&content);
    let element = decoder.decode_by_id(9).unwrap();
    let router =
        GeometryRouter::with_scale_and_rtc(scale, (translation[0], translation[1], translation[2]));
    let output = router
        .process_element_with_material_layers(&element, &mut decoder, &buildup(scale), &voids)
        .unwrap()
        .unwrap();
    assert!(output.ids_are_materials);
    assert_eq!(
        output
            .sub_meshes
            .iter()
            .map(|sub| sub.geometry_id)
            .collect::<Vec<_>>(),
        [200, 201, 200]
    );
    let bands = [(-0.15, -0.1), (-0.1, 0.1), (0.1, 0.15)];
    let mut area = 0.;
    for (sub, (low, high)) in output.sub_meshes.iter().zip(bands) {
        for triangle in sub.mesh.indices.chunks_exact(3) {
            let points: [crate::Vector3<f64>; 3] =
                std::array::from_fn(|i| local_point(&sub.mesh, triangle[i], rotated));
            for point in &points {
                assert!(
                    point.y >= low - 1e-5 && point.y <= high + 1e-5,
                    "material {} outside its layer: {point:?}",
                    sub.geometry_id
                );
            }
            let triangle_area = (points[1] - points[0])
                .cross(&(points[2] - points[0]))
                .norm()
                * 0.5;
            if triangle_area > 1e-8 {
                for interface in [-0.1, 0.1] {
                    assert!(
                        !points
                            .iter()
                            .all(|point| (point.y - interface).abs() < 1e-6),
                        "layer extraction must not create coincident interior caps"
                    );
                }
            }
            area += triangle_area;
        }
    }
    // Window: remove two unit-square faces, add four reveals of depth 0.3.
    let expected_area = if opening { 27.4 } else { 28.2 };
    assert!(
        (area - expected_area).abs() < 1e-4,
        "partition must retain the host's actual outer shell area: {area}"
    );
    assert_eq!(router.take_layer_slice_diag(), [(9, "ok:sliced")]);
}

#[test]
fn layer_gateway_partitions_outer_shell_without_interface_caps() {
    assert_partition(1., [0.; 3], false, false);
}

#[test]
fn layer_gateway_preserves_mm_rotated_survey_frame() {
    assert_partition(0.001, [5_000_000., 1_000_000., 300.], true, false);
}

#[test]
fn layer_gateway_partitions_the_actual_window_cut_host() {
    assert_partition(1., [0.; 3], false, true);
}
