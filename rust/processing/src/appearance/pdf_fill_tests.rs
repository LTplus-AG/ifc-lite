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
            property_set_global_id: "0cccccccccccccccccccc1".into(),
            property_relation_global_id: "0cccccccccccccccccccc2".into(),
            name: "PDF fill plan".into(),
            accepted_fidelity_sha256: None,
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
fn issue_4459_direct_pdf_fill_provenance_matches_mesh_without_removing_2d_symbols() {
    let (source, request) = fixture();
    let plan = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
    let exported = apply(&source, &plan.plan);
    let geometry = crate::process_geometry(exported.as_bytes());
    let (symbols, items) = crate::symbolic::extract_symbolic_data_with_provenance(exported.as_bytes()).into_parts();
    let fills: Vec<_> = symbols.fills.iter().enumerate().filter(|(_, f)| f.express_id == plan.annotation_id).collect();
    assert_eq!(fills.len(), 2, "2D drawing primitives must remain available");
    for (ordinal, fill) in fills {
        let item = items[ordinal].expect("direct fill must identify its source item");
        assert!(geometry.meshes.iter().any(|m| m.express_id == fill.express_id
            && m.geometry_item_id == Some(item) && !m.indices.is_empty()));
    }
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
fn issue_4406_fill_page_refuses_visible_omissions_without_acceptance_and_bad_geometry_always() {
    let (source, request) = fixture();
    // Known-unconvertible content: refused until the fidelity report is accepted.
    for operation in [
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Stroke,
            commands: vec![0., 0., 0., 2., 0., 1., 1., 1., 1., 0.],
        },
        PdfVectorOperator::Image {
            transforms: vec![[1., 0., 0., 1., 0., 0.]],
        },
        PdfVectorOperator::Unsupported {
            operator: "setFillTransparent".into(),
        },
    ] {
        let mut changed = request.clone();
        changed.page.operations.push(PdfVectorOperation {
            ordinal: 99,
            operation,
        });
        let error = plan_pdf_fill_annotation(source.as_bytes(), &changed).unwrap_err();
        assert!(error.contains("explicit acceptance"), "{error}");
    }
    // Geometric qualification failures refuse the whole page even when accepted.
    let mut concave = request.clone();
    concave.page.operations.push(PdfVectorOperation {
        ordinal: 99,
        operation: PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands: vec![0., 0., 0., 2., 0., 1., 1., 1., 1., 0., 4.],
        },
    });
    let report = crate::pdf_vector::prepare_pdf_vector_page(&concave.page).unwrap().fidelity;
    assert!(report.exact, "a curved fill is convertible content, not an omission");
    concave.accepted_fidelity_sha256 = Some(report.sha256);
    let error = plan_pdf_fill_annotation(source.as_bytes(), &concave).unwrap_err();
    assert!(!error.contains("acceptance"), "{error}");
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

#[test]
fn issue_4406_convex_bezier_fills_preserve_analytic_area_under_nonuniform_affine() {
    let (source, mut request)=fixture();
    request.page.tolerance_metres=0.01;
    for (commands, exact_area) in [
        (vec![0.,2.,2.,2.,2.,5.,5.,5.,5.,2.,4.],5.4),
        (vec![0.,2.,2.,3.,2.,5.,5.,5.,1.,5.,2.,4.],7.5),
    ] {
        for affine in [[1.,0.,0.,1.,0.,0.],[2.,0.3,0.5,1.,0.,0.],[-1.,0.,0.,1.,8.,0.]] {
            request.page.model_metres_from_pdf=affine;
            request.page.operations=vec![PdfVectorOperation{ordinal:0,operation:PdfVectorOperator::Path{
                paint:PdfVectorPaint::Fill,commands:commands.clone()}}];
            let plan=plan_pdf_fill_annotation(source.as_bytes(),&request).unwrap();
            assert_eq!(plan.meshes.len(),1);
            let expected=exact_area*(affine[0]*affine[3]-affine[1]*affine[2]).abs();
            assert!((area(&plan.meshes[0])-expected).abs()<0.015);
            let reopened=crate::process_geometry(apply(&source,&plan.plan).as_bytes());
            let mesh=reopened.meshes.iter().find(|m|m.express_id==plan.annotation_id).unwrap();
            assert_eq!(mesh.positions,plan.meshes[0].positions);
            assert_eq!(mesh.indices,plan.meshes[0].indices);
        }
    }
}

#[test]
fn issue_4406_curved_fill_refuses_unresolved_concavity_contacts_and_tiny_precision() {
    let (source,mut request)=fixture();
    request.page.tolerance_metres=0.01;
    request.page.operations=vec![PdfVectorOperation{ordinal:0,operation:PdfVectorOperator::Path{
        paint:PdfVectorPaint::Fill,commands:vec![0.,2.,2.,2.,2.,5.,5.,5.,5.,2.,4.]}}];
    let mut touching=request.clone();
    touching.page.operations.push(PdfVectorOperation{ordinal:1,operation:PdfVectorOperator::Path{
        paint:PdfVectorPaint::Fill,commands:rectangle(3.,2.,1.,1.)}});
    assert!(plan_pdf_fill_annotation(source.as_bytes(),&touching).unwrap_err().contains("error envelope"));
    let mut concave=request.clone();
    concave.page.operations[0].operation=PdfVectorOperator::Path{paint:PdfVectorPaint::Fill,
        commands:vec![0.,2.,2.,2.,2.,5.,5.,5.,5.,2.,1.,3.5,3.,4.]};
    assert!(plan_pdf_fill_annotation(source.as_bytes(),&concave).unwrap_err().contains("control hulls"));
    request.page.tolerance_metres=1e-9;
    assert!(plan_pdf_fill_annotation(source.as_bytes(),&request).is_err());
}

#[test]
fn issue_4406_actual_decoded_ellipse_hole_and_shear_controls_produce_complete_plans() {
    let (source, _)=fixture();
    for data in [
        include_str!("../../../../docs/architecture/evidence/pdf-curved-fill-annotations/page-1-request.json"),
        include_str!("../../../../docs/architecture/evidence/pdf-curved-fill-annotations/page-2-request.json"),
        include_str!("../../../../docs/architecture/evidence/pdf-curved-fill-annotations/page-3-request.json"),
    ] {
        let request:PdfFillAnnotationRequest=serde_json::from_str(data).unwrap();
        let plan=plan_pdf_fill_annotation(source.as_bytes(),&request).unwrap();
        assert_eq!(plan.regions.len(),1);
        assert_eq!(plan.meshes.len(),1);
        assert!(plan.geometry_work<=4_000_000);
        assert!(area(&plan.meshes[0])>1.);
    }
}

#[path = "pdf_stroke_tests.rs"]
mod stroke_tests;

#[test]
fn issue_4458_registered_cropbox_contacts_survive_classify_clip_and_paint_order() {
    let (source,_) = fixture();
    let request:PdfFillAnnotationRequest=serde_json::from_str(include_str!("../../../../docs/architecture/evidence/pdf-composition-lattice/registered-request.json")).unwrap();
    for tolerance in [0.001,0.0001,0.00001,0.000001,0.0000001] {
        let mut request=request.clone();request.page.tolerance_metres=tolerance;
        let result=plan_pdf_fill_annotation(source.as_bytes(),&request).unwrap();
        assert!((result.meshes.iter().map(area).sum::<f64>()-2.4).abs()<0.00001);
        assert_eq!(result.regions.len(),2);
        let reopened=crate::process_geometry(apply(&source,&result.plan).as_bytes());
        let total:f64=reopened.meshes.iter().filter(|m|m.express_id==result.annotation_id).map(area).sum();
        assert!((total-2.4).abs()<0.00001);
    }
}

#[test]
fn issue_4406_partial_page_needs_the_accepted_fidelity_digest_and_records_its_omissions() {
    let (source, request) = fixture();
    let mut partial = request.clone();
    partial.page.operations.push(PdfVectorOperation {
        ordinal: 99,
        operation: PdfVectorOperator::Text {
            quad: [1., 1., 3., 1., 3., 2., 1., 2.],
            invisible: false,
        },
    });
    let refused = plan_pdf_fill_annotation(source.as_bytes(), &partial).unwrap_err();
    assert!(refused.contains("1 visible omission)") && refused.contains("explicit acceptance"), "{refused}");
    let report = crate::pdf_vector::prepare_pdf_vector_page(&partial.page).unwrap().fidelity;
    assert!(!report.exact);
    let mut wrong = partial.clone();
    wrong.accepted_fidelity_sha256 = Some("0".repeat(64));
    assert!(plan_pdf_fill_annotation(source.as_bytes(), &wrong).unwrap_err().contains("does not match"));
    partial.accepted_fidelity_sha256 = Some(report.sha256.clone());
    let plan = plan_pdf_fill_annotation(source.as_bytes(), &partial).unwrap();
    assert_eq!(plan.regions.len(), 2, "the convertible fills still plan");
    assert!(!plan.fidelity.exact);
    assert_eq!(plan.fidelity.sha256, report.sha256);
    let step = apply(&source, &plan.plan);
    assert!(step.contains("IFCPROPERTYSET('0cccccccccccccccccccc1',$,'IfcLite_PdfVectorConversion',"), "{step}");
    assert!(step.contains("IFCPROPERTYSINGLEVALUE('AcceptedPartialConversion',$,IFCBOOLEAN(.T.),$)"));
    assert!(step.contains("IFCPROPERTYSINGLEVALUE('ExactConversion',$,IFCBOOLEAN(.F.),$)"));
    assert!(step.contains(r#"IFCPROPERTYSINGLEVALUE('Omissions',$,IFCTEXT('[{"kind":"text","count":1,"visible":1}]'),$)"#), "{step}");
    assert!(step.contains(&format!("IFCPROPERTYSINGLEVALUE('FidelitySha256',$,IFCIDENTIFIER('{}'),$)", report.sha256)));
    assert!(step.contains("IFCPROPERTYSINGLEVALUE('SourcePdfSha256',$,IFCIDENTIFIER('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),$)"));
    assert!(step.contains("IFCPROPERTYSINGLEVALUE('ToleranceMetres',$,IFCREAL(0.0001),$)"));
    assert!(step.contains("IFCPROPERTYSINGLEVALUE('SourceCropBox',$,IFCTEXT('[0.0,0.0,8.0,8.0]'),$)"), "{step}");
    assert!(step.contains(&format!("IFCRELDEFINESBYPROPERTIES('0cccccccccccccccccccc2',$,$,$,(#{}),#{});", plan.annotation_id, plan.property_set_id)), "{step}");
    assert!(step.contains("'PDF vectors, page 1: partial conversion; omitted 1 text run'"), "{step}");
    // The provenance rows do not disturb canonical geometry on reopen.
    let reopened = crate::process_geometry(step.as_bytes());
    assert_eq!(reopened.meshes.iter().filter(|m| m.express_id == plan.annotation_id).count(), 2);
    // An exact page records the same set without acceptance.
    let exact = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
    assert!(exact.fidelity.exact);
    let exact_step = apply(&source, &exact.plan);
    assert!(exact_step.contains("IFCPROPERTYSINGLEVALUE('ExactConversion',$,IFCBOOLEAN(.T.),$)"));
    assert!(exact_step.contains("IFCPROPERTYSINGLEVALUE('Omissions',$,IFCTEXT('[]'),$)"));
    assert!(exact_step.contains("IFCPROPERTYSINGLEVALUE('FillRegions',$,IFCINTEGER(2),$)"));
    assert!(exact_step.contains("'PDF vectors, page 1: exact conversion'"));
}

#[test]
fn issue_4406_raster_only_pages_and_duplicate_provenance_guids_refuse() {
    let (source, request) = fixture();
    let mut raster = request.clone();
    raster.page.operations = vec![PdfVectorOperation {
        ordinal: 0,
        operation: PdfVectorOperator::Image {
            transforms: vec![[8., 0., 0., 8., 0., 0.]],
        },
    }];
    let report = crate::pdf_vector::prepare_pdf_vector_page(&raster.page).unwrap().fidelity;
    assert!(report.raster_only);
    raster.accepted_fidelity_sha256 = Some(report.sha256);
    assert!(plan_pdf_fill_annotation(source.as_bytes(), &raster).unwrap_err().contains("raster reference"));
    let mut duplicate = request.clone();
    duplicate.property_relation_global_id = duplicate.global_id.clone();
    assert!(plan_pdf_fill_annotation(source.as_bytes(), &duplicate).unwrap_err().contains("distinct valid IFC GlobalIds"));
    let mut existing = request.clone();
    existing.property_set_global_id = "0$ScRe4drECQ4DMSqUjd6d".into();
    assert!(plan_pdf_fill_annotation(source.as_bytes(), &existing).unwrap_err().contains("already exists"));
}
