// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::appearance::{
    tests::{apply, CONTROLLED_IFC},
    AnnotationPlaneFrame,
};
use crate::pdf_vector::*;
fn rectangle(x: f64, y: f64, w: f64, h: f64) -> Vec<f64> {
    vec![0., x, y, 1., x + w, y, 1., x + w, y + h, 1., x, y + h, 4.]
}
fn fixture() -> (String, PdfFillAnnotationRequest) {
    let source=CONTROLLED_IFC.replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#11,$,$,.ELEMENT.,0.);\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    let mut outer = rectangle(0., 0., 10., 10.);
    outer.extend(rectangle(2., 2., 1., 1.));
    let ops = vec![
        PdfVectorOperator::FillColor { rgb: [1., 0., 0.] },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::EvenOddFill,
            commands: outer,
        },
        PdfVectorOperator::FillColor { rgb: [0., 0., 1.] },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands: rectangle(4., 4., 2., 2.),
        },
    ];
    (
        source,
        PdfFillAnnotationRequest {
            schema: "IFC4".into(),
            source_revision: "pdf-fill-test".into(),
            next_express_id: 100,
            container_id: 40,
            global_id: "0aaaaaaaaaaaaaaaaaaaaa".into(),
            containment_global_id: "0bbbbbbbbbbbbbbbbbbbbb".into(),
            name: "PDF fill plan".into(),
            frame: AnnotationPlaneFrame {
                origin: [2., 3., 4.],
                axis_u: [1., 0., 0.],
                axis_v: [0., 0., 1.],
                size_metres: [8., 8.],
            },
            page: PdfVectorPage {
                pdf_sha256: "a".repeat(64),
                decoder_version: "6.3.289".into(),
                page_number: 1,
                view_box: [0., 0., 8., 8.],
                user_unit: 1.,
                intrinsic_rotation: 0,
                model_metres_from_pdf: [1., 0., 0., 1., 0., 0.],
                calibration_key: "calibration-v1".into(),
                tolerance_metres: 0.0001,
                operations: ops
                    .into_iter()
                    .enumerate()
                    .map(|(i, operation)| PdfVectorOperation {
                        ordinal: i as u32,
                        operation,
                    })
                    .collect(),
            },
        },
    )
}
fn area(mesh: &crate::types::mesh::MeshData) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let p: Vec<_> = t
                .iter()
                .map(|i| &mesh.positions[*i as usize * 3..*i as usize * 3 + 3])
                .collect();
            let a: [f64; 3] = std::array::from_fn(|i| f64::from(p[1][i] - p[0][i]));
            let b: [f64; 3] = std::array::from_fn(|i| f64::from(p[2][i] - p[0][i]));
            let c = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            c.iter().map(|v| v * v).sum::<f64>().sqrt() / 2.
        })
        .sum()
}
#[test]
fn issue_4406_fill_page_preserves_evenodd_hole_crop_paint_order_and_native_reopen() {
    let (source, request) = fixture();
    let plan = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
    assert_eq!(plan.regions.len(), 2);
    assert_eq!(plan.meshes.len(), 2);
    let reopened = crate::process_geometry(apply(&source, &plan.plan).as_bytes());
    let meshes: Vec<_> = reopened
        .meshes
        .iter()
        .filter(|m| m.express_id == plan.annotation_id)
        .collect();
    assert_eq!(meshes.len(), 2);
    for m in &plan.meshes {
        let restored = meshes
            .iter()
            .find(|r| r.geometry_item_id == m.geometry_item_id)
            .unwrap();
        assert_eq!(restored.positions, m.positions);
        assert_eq!(restored.indices, m.indices);
        assert_eq!(restored.color, m.color);
        let expected = if m.color == [1., 0., 0., 1.] {
            59.
        } else {
            assert_eq!(m.color, [0., 0., 1., 1.]);
            4.
        };
        assert!(
            (area(m) - expected).abs() < 1e-6,
            "{} != {expected}",
            area(m)
        );
        for p in m.positions.chunks_exact(3) {
            let world: [f64; 3] =
                std::array::from_fn(|i| f64::from(p[i]) + m.origin[i] + plan.rtc_offset[i]);
            assert!((world[1] - 3.).abs() < 1e-6);
            assert!(world[0] >= 2. - 1e-6 && world[0] <= 10. + 1e-6);
            assert!(world[2] >= 4. - 1e-6 && world[2] <= 12. + 1e-6);
        }
    }
}
#[test]
fn issue_4406_fill_page_refuses_all_output_for_stroke_curve_or_unsupported_state() {
    let (source, request) = fixture();
    for operation in [
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Stroke,
            commands: rectangle(0., 0., 1., 1.),
        },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands: vec![0., 0., 0., 2., 0., 1., 1., 1., 1., 0., 4.],
        },
        PdfVectorOperator::Unsupported {
            operator: "paintImageXObject".into(),
        },
    ] {
        let mut changed = request.clone();
        changed.page.operations.push(PdfVectorOperation {
            ordinal: 99,
            operation,
        });
        assert!(plan_pdf_fill_annotation(source.as_bytes(), &changed).is_err());
    }
}

#[test]
fn issue_4406_fill_page_refuses_subgrid_hole_and_near_touching_island() {
    let (source, request) = fixture();
    for commands in [
        {
            let mut p = rectangle(0., 0., 8., 8.);
            p.extend(rectangle(2., 2., 1e-9, 1.));
            p
        },
        {
            let mut p = rectangle(0., 0., 2., 2.);
            p.extend(rectangle(2. + 1e-8, 0.5, 1., 1.));
            p
        },
    ] {
        let mut changed = request.clone();
        changed.page.operations = vec![PdfVectorOperation {
            ordinal: 1,
            operation: PdfVectorOperator::Path {
                paint: PdfVectorPaint::EvenOddFill,
                commands,
            },
        }];
        let error = plan_pdf_fill_annotation(source.as_bytes(), &changed).unwrap_err();
        assert!(
            error.contains("quantization") || error.contains("too close"),
            "{error}"
        );
    }
}
#[test]
fn issue_4406_nonzero_winding_and_millimetre_horizontal_placement_preserve_areas() {
    let (source, mut request) = fixture();
    let source = source.replace(".LENGTHUNIT.,$,.METRE.", ".LENGTHUNIT.,.MILLI.,.METRE.");
    request.frame.axis_v = [0., 1., 0.];
    for reversed in [false, true] {
        let mut commands = rectangle(0., 0., 10., 10.);
        if reversed {
            commands.extend([0., 2., 2., 1., 2., 3., 1., 3., 3., 1., 3., 2., 4.]);
        } else {
            commands.extend(rectangle(2., 2., 1., 1.));
        }
        request.page.operations[1].operation = PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands,
        };
        let plan = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
        let red = plan
            .meshes
            .iter()
            .find(|m| m.color == [1., 0., 0., 1.])
            .unwrap();
        assert!((area(red) - if reversed { 59. } else { 60. }).abs() < 1e-6);
        for m in &plan.meshes {
            for p in m.positions.chunks_exact(3) {
                assert!((f64::from(p[2]) + m.origin[2] + plan.rtc_offset[2] - 4.).abs() < 1e-6);
            }
        }
        let restored = crate::process_geometry(apply(&source, &plan.plan).as_bytes());
        assert_eq!(
            restored
                .meshes
                .iter()
                .filter(|m| m.express_id == plan.annotation_id)
                .count(),
            plan.meshes.len()
        );
    }
}
#[test]
fn issue_4406_fill_plan_binds_source_page_frame_and_allocator_and_refuses_bad_metadata() {
    let (source, request) = fixture();
    let before = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
    for i in 0..4 {
        let mut changed = request.clone();
        match i {
            0 => changed.frame.origin[0] += 1.,
            1 => changed.next_express_id += 10,
            2 => changed.page.pdf_sha256 = "b".repeat(64),
            _ => changed.page.calibration_key = "changed".into(),
        }
        assert_ne!(
            plan_pdf_fill_annotation(source.as_bytes(), &changed)
                .unwrap()
                .request_sha256,
            before.request_sha256
        );
    }
    let mut changed = request.clone();
    changed.name = "#123".into();
    assert!(plan_pdf_fill_annotation(source.as_bytes(), &changed)
        .unwrap_err()
        .contains("reserved appearance wire token"));
    changed = request.clone();
    changed.next_express_id = 40;
    assert!(plan_pdf_fill_annotation(source.as_bytes(), &changed)
        .unwrap_err()
        .contains("allocator"));
}
