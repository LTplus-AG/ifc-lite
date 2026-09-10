// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
fn page(ops: Vec<PdfVectorOperator>) -> PdfVectorPage {
    PdfVectorPage {
        pdf_sha256: "a".repeat(64),
        decoder_version: "6.3.289".into(),
        page_number: 1,
        view_box: [10., 20., 110., 92.],
        user_unit: 2.,
        intrinsic_rotation: 90,
        model_metres_from_pdf: [0., -0.002, 0.002, 0., -0.04, 0.22],
        calibration_key: "measured-wall-v1".into(),
        tolerance_metres: 0.0001,
        operations: ops
            .into_iter()
            .enumerate()
            .map(|(i, operation)| PdfVectorOperation {
                ordinal: i as u32 * 2,
                operation,
            })
            .collect(),
    }
}
fn path() -> PdfVectorOperator {
    PdfVectorOperator::Path {
        paint: PdfVectorPaint::Stroke,
        commands: vec![0., 10., 20., 1., 82., 20.],
    }
}
#[test]
fn issue_4406_calibrated_transform_preserves_stroke_construction_space_and_restore() {
    let input = page(vec![
        PdfVectorOperator::Save,
        PdfVectorOperator::Transform {
            matrix: [2., 0., 0., 3., 4., 5.],
        },
        PdfVectorOperator::LineWidth { width: 2. },
        PdfVectorOperator::Dash {
            lengths: vec![4., 2.],
            phase: 1.,
        },
        path(),
        PdfVectorOperator::Restore,
        path(),
    ]);
    let report = prepare_pdf_vector_page(&input).unwrap();
    assert!(report.state_qualified);
    assert!(!report.geometry_ready);
    assert_eq!(report.page_clip_pdf, input.view_box);
    assert!(report.pending_geometry.contains(&"pageClip"));
    let transformed = &report.paths[0];
    assert_eq!(transformed.operator_ordinal, 8);
    assert_eq!(transformed.state.line_width, 2.);
    assert_eq!(transformed.state.dash_lengths, [4., 2.]);
    let m = transformed.state.model_metres_from_path;
    // Independent successive maps: path (10,20) -> PDF (24,65) -> metres (.09,.172).
    assert!((m[0] * 10. + m[2] * 20. + m[4] - 0.09).abs() < 1e-15);
    assert!((m[1] * 10. + m[3] * 20. + m[5] - 0.172).abs() < 1e-15);
    assert_eq!(
        report.paths[1].state.model_metres_from_path,
        input.model_metres_from_pdf
    );
    assert_eq!(report.paths[1].state.line_width, 1.);
    assert!(report.paths[1].state.dash_lengths.is_empty());
}
#[test]
fn issue_4406_preserves_curves_fill_rules_and_paint_order_without_claiming_flattening() {
    let commands = vec![
        0., 0., 0., 2., 1., 3., 2., 3., 3., 0., 3., 4., 1., 5., 0., 4.,
    ];
    let report = prepare_pdf_vector_page(&page(vec![
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::EvenOddFill,
            commands: commands.clone(),
        },
        PdfVectorOperator::FillColor { rgb: [1., 0., 0.] },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands: commands.clone(),
        },
    ]))
    .unwrap();
    assert_eq!(report.paths[0].commands, commands);
    assert_eq!(report.paths[0].paint, PdfVectorPaint::EvenOddFill);
    assert_eq!(report.paths[0].state.fill_rgb, [0., 0., 0.]);
    assert_eq!(report.paths[1].state.fill_rgb, [1., 0., 0.]);
    assert!(report.paths[0].operator_ordinal < report.paths[1].operator_ordinal);
}
#[test]
fn issue_4406_unsupported_content_and_painted_hairlines_never_qualify_partial_paths() {
    let report = prepare_pdf_vector_page(&page(vec![
        PdfVectorOperator::LineWidth { width: 0. },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::EndPath,
            commands: vec![],
        },
        path(),
        PdfVectorOperator::Unsupported {
            operator: "showText".into(),
        },
        PdfVectorOperator::Unsupported {
            operator: "clip".into(),
        },
    ]))
    .unwrap();
    assert!(!report.state_qualified);
    assert_eq!(report.paths.len(), 1);
    assert_eq!(report.diagnostics.len(), 3);
    assert_eq!(report.diagnostics[0].operator_ordinal, 4);
    assert_eq!(report.diagnostics[1].code, "unsupported:showText");
}
#[test]
fn issue_4406_binds_page_source_calibration_tolerance_and_original_operator_identity() {
    let input = page(vec![path()]);
    let digest = prepare_pdf_vector_page(&input).unwrap().request_sha256;
    for mutation in 0..5 {
        let mut changed = input.clone();
        match mutation {
            0 => changed.pdf_sha256 = "b".repeat(64),
            1 => changed.page_number = 2,
            2 => changed.calibration_key.push('2'),
            3 => changed.tolerance_metres *= 2.,
            _ => changed.operations[0].ordinal = 42,
        }
        assert_ne!(
            prepare_pdf_vector_page(&changed).unwrap().request_sha256,
            digest
        );
    }
}
#[test]
fn issue_4406_malformed_state_paths_ordinals_and_numeric_values_refuse_atomically() {
    let cases = vec![
        vec![PdfVectorOperator::Restore],
        vec![PdfVectorOperator::Save],
        vec![PdfVectorOperator::Save; 65],
        vec![PdfVectorOperator::Transform {
            matrix: [1., 0., 2., 0., 0., 0.],
        }],
        vec![PdfVectorOperator::FillColor {
            rgb: [f64::NAN, 0., 0.],
        }],
        vec![PdfVectorOperator::LineWidth { width: -1. }],
        vec![PdfVectorOperator::LineCap { cap: 3 }],
        vec![PdfVectorOperator::Dash {
            lengths: vec![0., 0.],
            phase: 0.,
        }],
        vec![PdfVectorOperator::Dash {
            lengths: vec![1.; 129],
            phase: 0.,
        }],
        vec![PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands: vec![0., 1.],
        }],
        vec![PdfVectorOperator::Path {
            paint: PdfVectorPaint::Fill,
            commands: vec![1., 1., 2.],
        }],
    ];
    for ops in cases {
        assert!(prepare_pdf_vector_page(&page(ops)).is_err());
    }
    let mut input = page(vec![path(), path()]);
    input.operations[1].ordinal = 0;
    assert!(prepare_pdf_vector_page(&input)
        .unwrap_err()
        .contains("ordinals"));
    input.operations = vec![
        PdfVectorOperation {
            ordinal: 1,
            operation: path()
        };
        100_001
    ];
    assert!(prepare_pdf_vector_page(&input)
        .unwrap_err()
        .contains("100000"));
}
#[test]
fn issue_4406_strict_json_rejects_unknown_semantics_instead_of_dropping_them() {
    let mut json = serde_json::to_value(page(vec![path()])).unwrap();
    json["operations"][0]["operation"]["alpha"] = serde_json::json!(0.5);
    assert!(serde_json::from_value::<PdfVectorPage>(json).is_err());
}
