// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
pub(super) fn page(ops: Vec<PdfVectorOperator>) -> PdfVectorPage {
    PdfVectorPage {
        pdf_sha256: "a".repeat(64),
        decoder_version: "6.3.289".into(),
        pdf_format_version: Some("2.0".into()),
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
pub(super) fn path() -> PdfVectorOperator {
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
        path(),
        PdfVectorOperator::Restore,
        path(),
    ]);
    let report = prepare_pdf_vector_page(&input).unwrap();
    assert!(report.fidelity.exact);
    assert_eq!(report.fidelity.convertible_paths, 2);
    assert_eq!(report.page_clip_pdf, input.view_box);
    let transformed = &report.paths[0];
    assert_eq!(transformed.operator_ordinal, 6);
    assert_eq!(transformed.state.line_width, 2.);
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
fn issue_4406_conversion_clip_filters_off_crop_geometry_without_rewriting_source_cropbox() {
    let input = page(vec![
        PdfVectorOperator::Path { paint: PdfVectorPaint::Stroke, commands: vec![0., 15., 25., 1., 19., 25.] },
        PdfVectorOperator::Path { paint: PdfVectorPaint::Stroke, commands: vec![0., 80., 80., 1., 90., 80.] },
    ]);
    let prepared = prepare_pdf_vector_page_with_clip(&input, Some([10., 20., 20., 30.])).unwrap();
    assert_eq!(prepared.page_clip_pdf, [10., 20., 20., 30.]);
    assert_eq!(prepared.paths.len(), 1, "only the supported on-crop paint reaches geometry");
    assert_eq!(prepared.paths[0].operator_ordinal, 0);
    assert!(prepared.fidelity.exact);

    assert!(prepare_pdf_vector_page_with_clip(&input, Some([9., 20., 20., 30.]))
        .unwrap_err().contains("conversion clip"));
}
#[test]
fn issue_4406_conversion_clip_cannot_prove_an_outside_hairline_invisible() {
    let input = page(vec![
        PdfVectorOperator::LineWidth { width: 0. },
        PdfVectorOperator::Path { paint: PdfVectorPaint::Stroke,
            commands: vec![0., 70., 70., 1., 75., 70.] },
    ]);
    let prepared = prepare_pdf_vector_page_with_clip(&input, Some([10., 20., 20., 30.])).unwrap();
    assert!(!prepared.fidelity.exact,
        "device-minimum ink may bleed into an interior crop even when its centreline is outside");
    assert_eq!(prepared.fidelity.summary[0].kind, "hairline");
    assert_eq!(prepared.fidelity.summary[0].visible_count, 1);
}
#[test]
fn issue_4406_conversion_clip_counts_a_wide_stroke_whose_centerline_is_outside() {
    let input = page(vec![
        PdfVectorOperator::LineWidth { width: 6. },
        PdfVectorOperator::Path { paint: PdfVectorPaint::Stroke, commands: vec![0., 7., 25., 1., 8., 25.] },
    ]);
    let error = prepare_pdf_vector_page_with_clip(&input, Some([10., 20., 20., 30.])).unwrap_err();
    assert!(error.contains("conversion boundary crosses painted path"),
        "the centreline is outside, but its painted envelope overlaps the crop: {error}");
}
#[test]
fn issue_4406_conversion_clip_combines_square_caps_with_small_miter_limit() {
    let input = page(vec![
        PdfVectorOperator::LineWidth { width: 2. },
        PdfVectorOperator::LineCap { cap: 2 },
        PdfVectorOperator::LineJoin { join: 0 },
        PdfVectorOperator::MiterLimit { limit: 1. },
        PdfVectorOperator::Path { paint: PdfVectorPaint::Stroke,
            commands: vec![0., 11.5, 22., 1., 15., 22., 1., 15., 28.] },
    ]);
    let error = prepare_pdf_vector_page_with_clip(&input, Some([10., 20., 20., 30.])).unwrap_err();
    assert!(error.contains("conversion boundary crosses painted path"),
        "square end caps remain part of the envelope when the miter limit is smaller: {error}");
}
#[test]
fn issue_4613_omission_extent_stays_in_the_independent_control_point_contract() {
    let input = page(vec![
        PdfVectorOperator::LineWidth { width: 2. },
        PdfVectorOperator::Path {
            paint: PdfVectorPaint::Stroke,
            commands: vec![0., 120., 20., 2., 120., 100., 220., 100., 220., 20.],
        },
    ]);
    let prepared = prepare_pdf_vector_page(&input).unwrap();
    let omission = &prepared.fidelity.omissions[0];
    assert_eq!(omission.kind, "curvedStroke");
    // The MuPDF oracle records cubic controls in this frame. The separate
    // painted-ink envelope expands by the default miter limit for fail-closed
    // crop decisions, but must not shift this independently checked extent.
    assert_eq!(omission.bbox_pdf, Some([120., 20., 220., 100.]));
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
fn issue_4406_unsupported_content_and_painted_hairlines_are_reported_not_converted() {
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
            operator: "setFillTransparent".into(),
        },
    ]))
    .unwrap();
    assert!(!report.fidelity.exact);
    assert!(report.paths.is_empty(), "a hairline is never a convertible path");
    let kinds: Vec<_> = report.fidelity.omissions.iter().map(|o| (o.operator_ordinal, o.kind.as_str())).collect();
    assert_eq!(kinds, [(4, "hairline"), (6, "unsupported:showText"), (8, "unsupported:setFillTransparent")]);
    assert_eq!(report.fidelity.omitted_paints, 1);
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
#[test]
fn issue_4583_older_hosts_without_a_pdf_version_remain_decodable() {
    let mut json = serde_json::to_value(page(vec![path()])).unwrap();
    json.as_object_mut().unwrap().remove("pdfFormatVersion");
    let decoded: PdfVectorPage = serde_json::from_value(json).unwrap();
    assert_eq!(decoded.pdf_format_version, None);

    let mut invalid = page(vec![path()]);
    invalid.pdf_format_version = Some("x".repeat(17));
    assert!(prepare_pdf_vector_page(&invalid)
        .unwrap_err()
        .contains("format version"));
}
#[test]
fn issue_4406_report_operators_use_the_adapter_camel_case_wire_shape() {
    let mut json = serde_json::to_value(page(vec![path()])).unwrap();
    json["operations"] = serde_json::json!([
        {"ordinal": 0, "operation": {"kind": "clip", "evenOdd": true}},
        {"ordinal": 1, "operation": {"kind": "graphicsState", "lineWidth": 2.5, "lineCap": null, "lineJoin": 2,
            "miterLimit": null, "dash": [[1.0, 2.0], 0.5], "transparency": ["ca"], "unsupported": []}},
        {"ordinal": 2, "operation": {"kind": "text", "quad": [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0], "invisible": false}},
        {"ordinal": 3, "operation": {"kind": "formBegin", "matrix": null, "bbox": [0.0, 0.0, 500.0, 500.0]}},
        {"ordinal": 4, "operation": {"kind": "markedContent", "visible": false}},
        {"ordinal": 5, "operation": {"kind": "endMarkedContent"}},
        {"ordinal": 6, "operation": {"kind": "formEnd"}}
    ]);
    let page: PdfVectorPage = serde_json::from_value(json).unwrap();
    assert!(matches!(page.operations[0].operation, PdfVectorOperator::Clip { even_odd: true }));
    match &page.operations[1].operation {
        PdfVectorOperator::GraphicsState { line_width, line_join, dash, transparency, .. } => {
            assert_eq!((*line_width, *line_join), (Some(2.5), Some(2)));
            assert_eq!(dash.as_ref().map(|(l, p)| (l.clone(), *p)), Some((vec![1., 2.], 0.5)));
            assert_eq!(transparency, &["ca".to_string()]);
        }
        other => panic!("{other:?}"),
    }
    let report = prepare_pdf_vector_page(&page).unwrap();
    assert_eq!(report.fidelity.summary.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), ["text"]);
    let mut wrong = serde_json::to_value(page).unwrap();
    wrong["operations"][0]["operation"] = serde_json::json!({"kind": "clip", "even_odd": true});
    assert!(serde_json::from_value::<PdfVectorPage>(wrong).is_err(), "snake_case is not the adapter wire shape");
}
