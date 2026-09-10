// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
fn stroke(
    commands: Vec<f64>,
    cap: u8,
    join: u8,
    limit: f64,
    matrix: [f64; 6],
) -> (String, PdfFillAnnotationRequest) {
    let (source, mut request) = fixture();
    request.page.view_box = [-100., -100., 100., 100.];
    request.page.model_metres_from_pdf = matrix;
    request.page.operations = vec![
        PdfVectorOperator::LineWidth { width: 2. },
        PdfVectorOperator::LineCap { cap },
        PdfVectorOperator::LineJoin { join },
        PdfVectorOperator::MiterLimit { limit },
        PdfVectorOperator::StrokeColor { rgb: [0., 1., 0.] },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Stroke,
            commands,
        },
    ]
    .into_iter()
    .enumerate()
    .map(|(i, operation)| PdfVectorOperation {
        ordinal: i as u32,
        operation,
    })
    .collect();
    (source, request)
}
#[test]
fn issue_4406_stroke_caps_joins_and_miter_cutoff_have_analytic_area_after_affine_and_reopen() {
    for matrix in [
        [1., 0., 0., 1., 0., 0.],
        [2., 0.2, 0.5, 0.8, 3., 4.],
        [-1., 0., 0., 2., 4., 5.],
    ] {
        let determinant: f64 = matrix[0] * matrix[3] - matrix[1] * matrix[2];
        for (commands, cap, join, limit, expected) in [
            (vec![0., 0., 0., 1., 4., 0.], 0, 0, 10., 8.),
            (vec![0., 0., 0., 1., 4., 0.], 2, 0, 10., 12.),
            (vec![0., 0., 0., 1., 4., 0., 1., 4., 4.], 0, 0, 10., 16.),
            (vec![0., 0., 0., 1., 4., 0., 1., 4., 4.], 0, 2, 10., 15.5),
            (vec![0., 0., 0., 1., 4., 0., 1., 4., 4.], 0, 0, 1., 15.5),
        ] {
            let (source, request) = stroke(commands, cap, join, limit, matrix);
            let result = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
            let expected = expected * determinant.abs();
            assert!((result.meshes.iter().map(area).sum::<f64>() - expected).abs() < 0.0001);
            assert!(result
                .regions
                .iter()
                .all(|r| r.source_operator_ordinal == 5 && r.rgb == [0., 1., 0.]));
            let reopened = crate::process_geometry(apply(&source, &result.plan).as_bytes());
            let meshes: Vec<_> = reopened
                .meshes
                .iter()
                .filter(|m| m.express_id == result.annotation_id)
                .collect();
            assert!((meshes.iter().map(|m| area(m)).sum::<f64>() - expected).abs() < 0.0001);
        }
    }
}
#[test]
fn issue_4406_combined_fill_stroke_retains_stroke_over_fill_and_closed_hole() {
    let (source, mut request) = stroke(
        rectangle(0., 0., 4., 4.),
        0,
        0,
        10.,
        [1., 0., 0., 1., 0., 0.],
    );
    if let PdfVectorOperator::Path { paint, .. } = &mut request.page.operations[5].operation {
        *paint = PdfVectorPaint::FillStroke;
    }
    let result = plan_pdf_fill_annotation(source.as_bytes(), &request).unwrap();
    assert!((result.meshes.iter().map(area).sum::<f64>() - 36.).abs() < 0.0001);
    let green: f64 = result
        .meshes
        .iter()
        .filter(|m| m.color[1] == 1.)
        .map(area)
        .sum();
    assert!((green - 32.).abs() < 0.0001);
    assert_eq!(result.regions.len(), 2);
}
#[test]
fn issue_4406_unsupported_strokes_refuse_whole_page() {
    let (source, request) = stroke(
        vec![0., 0., 0., 1., 4., 0.],
        0,
        0,
        10.,
        [1., 0., 0., 1., 0., 0.],
    );
    for operation in [
        PdfVectorOperator::LineCap { cap: 1 },
        PdfVectorOperator::LineJoin { join: 1 },
        PdfVectorOperator::LineWidth { width: 0. },
        PdfVectorOperator::Dash {
            lengths: vec![1., 1.],
            phase: 0.,
        },
    ] {
        let mut bad = request.clone();
        bad.page.operations.insert(
            5,
            PdfVectorOperation {
                ordinal: 5,
                operation,
            },
        );
        bad.page.operations[6].ordinal = 6;
        assert!(plan_pdf_fill_annotation(source.as_bytes(), &bad).is_err());
    }
}
#[test]
fn issue_4406_strokes_refuse_collapsed_offsets_reversals_crossings_and_exhaustion() {
    for commands in [
        rectangle(0., 0., 1., 1.),
        vec![0., 0., 0., 1., 4., 0., 1., 0., 0.],
        vec![0., 0., 0., 1., 4., 4., 1., 0., 4., 1., 4., 0.],
        vec![0., 0., 0., 1., 0., 0.],
    ] {
        let (source, request) = stroke(commands, 0, 0, 10., [1., 0., 0., 1., 0., 0.]);
        assert!(plan_pdf_fill_annotation(source.as_bytes(), &request).is_err());
    }
}
#[test]
fn issue_4406_actual_decoded_stroke_pages_preserve_analytic_areas() {
    let (source,_) = fixture();
    for (data,expected) in [
        (include_str!("../../../../docs/architecture/evidence/pdf-straight-stroke-annotations/page-1-request.json"),2.4),
        (include_str!("../../../../docs/architecture/evidence/pdf-straight-stroke-annotations/page-2-request.json"),2.54),
        (include_str!("../../../../docs/architecture/evidence/pdf-straight-stroke-annotations/page-3-request.json"),2.38),
        (include_str!("../../../../docs/architecture/evidence/pdf-straight-stroke-annotations/page-4-request.json"),19.36),
        (include_str!("../../../../docs/architecture/evidence/pdf-straight-stroke-annotations/page-5-request.json"),1.5768),
    ] {
        let request:PdfFillAnnotationRequest=serde_json::from_str(data).unwrap();
        let result=plan_pdf_fill_annotation(source.as_bytes(),&request).unwrap();
        assert!((result.meshes.iter().map(area).sum::<f64>()-expected).abs()<0.0001);
        assert!(result.geometry_work<=4_000_000);
    }
}
