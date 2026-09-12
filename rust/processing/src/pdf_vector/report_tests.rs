// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Fidelity report semantics (#4406): what is omitted, where, whether it is
//! visible, and how scopes/clips/state taints bound the convertible subset.
use super::tests::{page, path};
use super::*;
use PdfVectorOperator as Op;

fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<f64> {
    vec![0., x, y, 1., x + w, y, 1., x + w, y + h, 1., x, y + h, 4.]
}
fn fill(commands: Vec<f64>) -> Op {
    Op::Path {
        paint: PdfVectorPaint::Fill,
        commands,
    }
}
fn end_path(commands: Vec<f64>) -> Op {
    Op::Path {
        paint: PdfVectorPaint::EndPath,
        commands,
    }
}
fn kinds(report: &PreparedPdfVectorPage) -> Vec<(u32, String, bool)> {
    report
        .fidelity
        .omissions
        .iter()
        .map(|o| (o.operator_ordinal, o.kind.clone(), o.visible))
        .collect()
}
fn gstate(transparency: &[&str], unsupported: &[&str]) -> Op {
    Op::GraphicsState {
        line_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        transparency: transparency.iter().map(|s| s.to_string()).collect(),
        unsupported: unsupported.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn issue_4406_exact_page_reports_no_visible_omissions_and_binds_its_verdict() {
    let exact = prepare_pdf_vector_page(&page(vec![path(), fill(rect(20., 30., 10., 10.))])).unwrap();
    assert!(exact.fidelity.exact && !exact.fidelity.raster_only);
    assert_eq!(exact.fidelity.convertible_paths, 2);
    assert!(exact.fidelity.omissions.is_empty() && exact.fidelity.summary.is_empty());
    assert_eq!(exact.fidelity.algorithm, FIDELITY_ALGORITHM);
    let again = prepare_pdf_vector_page(&page(vec![path(), fill(rect(20., 30., 10., 10.))])).unwrap();
    assert_eq!(again.fidelity.sha256, exact.fidelity.sha256);
    let partial = prepare_pdf_vector_page(&page(vec![
        path(),
        fill(rect(20., 30., 10., 10.)),
        Op::Text {
            quad: [20., 30., 40., 30., 40., 35., 20., 35.],
            invisible: false,
        },
    ]))
    .unwrap();
    assert!(!partial.fidelity.exact);
    assert_ne!(partial.fidelity.sha256, exact.fidelity.sha256);
    assert_eq!(partial.fidelity.describe(), "partial conversion; omitted 1 text run");
    assert_eq!(exact.fidelity.describe(), "exact conversion");
    let mut many = vec![Op::LineWidth { width: 0. }, path(), path(), Op::LineWidth { width: 1. }, Op::LineCap { cap: 1 }, path()];
    many.push(Op::Unsupported {
        operator: "setGState:TR".into(),
    });
    let described = prepare_pdf_vector_page(&page(many)).unwrap().fidelity;
    assert_eq!(
        described.describe(),
        "partial conversion; omitted 2 hairline strokes, 1 round-cap/join stroke, 1 entry under unsupported operator setGState:TR"
    );
}

/// Exporters routinely clip to a rectangle a few thousandths of a point inside
/// the CropBox; that loss is below the declared tolerance and must not taint
/// the page, while a clip short by more than the tolerance still does.
#[test]
fn issue_4406_page_clip_short_of_the_cropbox_by_less_than_the_tolerance_is_a_noop() {
    // The test page maps one PDF unit to 2 mm, so 1 mm is half a PDF unit.
    let clipped = |shortfall: f64, tolerance_metres: f64| {
        let mut input = page(vec![
            Op::Clip { even_odd: false },
            end_path(rect(10., 20., 100. - shortfall, 72. - shortfall)),
            path(),
        ]);
        input.tolerance_metres = tolerance_metres;
        prepare_pdf_vector_page(&input).unwrap()
    };
    let tolerated = clipped(0.01, 0.001);
    assert!(tolerated.fidelity.exact, "0.01 pt shortfall at 1 mm tolerance removes nothing reportable");
    assert_eq!(tolerated.paths.len(), 1);
    let tolerated_form = {
        let mut input = page(vec![
            Op::FormBegin {
                matrix: None,
                bbox: Some([10., 20., 109.99, 91.99]),
            },
            path(),
            Op::FormEnd,
        ]);
        input.tolerance_metres = 0.001;
        prepare_pdf_vector_page(&input).unwrap()
    };
    assert!(tolerated_form.fidelity.exact && tolerated_form.paths.len() == 1);
    let reported = clipped(0.01, 0.000_001);
    assert_eq!(kinds(&reported), [(4, "clip".into(), true)], "the same shortfall above a 1 µm tolerance is reported");
    let beyond = clipped(0.6, 0.001);
    assert_eq!(kinds(&beyond), [(4, "clip".into(), true)], "0.6 pt (1.2 mm) exceeds a 1 mm tolerance");
}

#[test]
fn issue_4406_text_image_and_shading_carry_page_extent_and_visibility() {
    let report = prepare_pdf_vector_page(&page(vec![
        Op::Save,
        Op::Transform {
            matrix: [1., 0., 0., 1., 50., 50.],
        },
        Op::Text {
            quad: [0., 0., 10., 0., 10., 5., 0., 5.],
            invisible: false,
        },
        Op::Text {
            quad: [0., 0., 10., 0., 10., 5., 0., 5.],
            invisible: true,
        },
        Op::Restore,
        Op::Save,
        Op::Transform {
            matrix: [1., 0., 0., 1., 500., 500.],
        },
        Op::Text {
            quad: [0., 0., 10., 0., 10., 5., 0., 5.],
            invisible: false,
        },
        Op::Restore,
        Op::Save,
        Op::Transform {
            matrix: [30., 0., 0., 20., 15., 25.],
        },
        Op::Image {
            transforms: vec![[1., 0., 0., 1., 0., 0.]],
        },
        Op::Restore,
        Op::Shading,
        fill(rect(20., 30., 10., 10.)),
    ]))
    .unwrap();
    let f = &report.fidelity;
    assert!(!f.exact && !f.raster_only);
    assert_eq!(f.convertible_paths, 1);
    let text: Vec<_> = f.omissions.iter().filter(|o| o.kind == "text").collect();
    assert_eq!(text.len(), 3);
    assert_eq!(text[0].bbox_pdf, Some([50., 50., 60., 55.]));
    assert!(text[0].visible);
    assert!(!text[1].visible, "render mode 3/7 text is not visible");
    assert!(!text[2].visible, "text outside the CropBox is not visible");
    let image = f.omissions.iter().find(|o| o.kind == "image").unwrap();
    assert_eq!(image.bbox_pdf, Some([15., 25., 45., 45.]));
    assert!(image.visible);
    let shading = f.omissions.iter().find(|o| o.kind == "pattern").unwrap();
    assert_eq!(shading.bbox_pdf, Some(report.page_clip_pdf));
    let text_summary = f.summary.iter().find(|s| s.kind == "text").unwrap();
    assert_eq!((text_summary.count, text_summary.visible_count), (3, 1));
    assert_eq!(text_summary.bbox_pdf, Some([50., 50., 60., 55.]), "summary extent unions visible entries only");
}

#[test]
fn issue_4406_rectangular_clip_containing_the_page_is_a_noop_and_other_clips_taint_their_scope() {
    let noop = prepare_pdf_vector_page(&page(vec![
        Op::Clip { even_odd: false },
        end_path(rect(0., 0., 200., 200.)),
        path(),
    ]))
    .unwrap();
    assert!(noop.fidelity.exact);
    assert_eq!(noop.paths.len(), 1);
    let scoped = prepare_pdf_vector_page(&page(vec![
        Op::Save,
        Op::Clip { even_odd: true },
        end_path(rect(20., 30., 20., 20.)),
        path(),
        fill(rect(20., 30., 10., 10.)),
        Op::Restore,
        path(),
    ]))
    .unwrap();
    assert!(!scoped.fidelity.exact);
    assert_eq!(kinds(&scoped), [(6, "clip".into(), true), (8, "clip".into(), true)]);
    assert_eq!(scoped.paths.len(), 1);
    assert_eq!(scoped.paths[0].operator_ordinal, 12);
    // A clip declared with the painting operator paints first, then clips.
    let paint_then_clip = prepare_pdf_vector_page(&page(vec![
        Op::Clip { even_odd: false },
        fill(rect(20., 30., 20., 20.)),
        path(),
    ]))
    .unwrap();
    assert_eq!(paint_then_clip.paths.len(), 1);
    assert_eq!(paint_then_clip.paths[0].operator_ordinal, 2);
    assert_eq!(kinds(&paint_then_clip), [(4, "clip".into(), true)]);
    // A rotated page transform still recognises a containing rectangle.
    let rotated = prepare_pdf_vector_page(&page(vec![
        Op::Transform {
            matrix: [0., 1., -1., 0., 120., 0.],
        },
        Op::Clip { even_odd: false },
        end_path(rect(0., 0., 300., 300.)),
        path(),
        Op::TextClip,
        path(),
    ]))
    .unwrap();
    assert_eq!(rotated.paths.len(), 1);
    assert_eq!(kinds(&rotated), [(10, "clip".into(), true)]);
}

#[test]
fn issue_4406_form_scope_applies_matrix_and_bbox_then_restores_outer_state() {
    let report = prepare_pdf_vector_page(&page(vec![
        Op::FormBegin {
            matrix: Some([2., 0., 0., 2., 0., 0.]),
            bbox: Some([0., 0., 100., 100.]),
        },
        Op::LineWidth { width: 3. },
        path(),
        Op::FormEnd,
        path(),
        Op::FormBegin {
            matrix: None,
            bbox: Some([20., 30., 40., 50.]),
        },
        path(),
        Op::FormEnd,
        path(),
    ]))
    .unwrap();
    assert_eq!(report.paths.len(), 3);
    let inner = &report.paths[0];
    assert_eq!(inner.state.line_width, 3.);
    let m = inner.state.model_metres_from_path;
    let base = page(vec![]).model_metres_from_pdf;
    assert!((m[0] - base[0] * 2.).abs() < 1e-15 && (m[1] - base[1] * 2.).abs() < 1e-15);
    assert_eq!(report.paths[1].state.line_width, 1.);
    assert_eq!(report.paths[1].state.model_metres_from_path, base);
    assert_eq!(kinds(&report), [(12, "clip".into(), true)]);
    assert_eq!(report.paths[2].operator_ordinal, 16);
}

#[test]
fn issue_4406_groups_are_transparent_only_when_composited() {
    let simple = prepare_pdf_vector_page(&page(vec![
        Op::GroupBegin {
            composited: false,
            matrix: Some([1., 0., 0., 1., 0., 0.]),
            bbox: Some([0., 0., 500., 500.]),
        },
        Op::FormBegin {
            matrix: None,
            bbox: None,
        },
        path(),
        Op::FormEnd,
        Op::GroupEnd,
    ]))
    .unwrap();
    assert!(simple.fidelity.exact);
    let composited = prepare_pdf_vector_page(&page(vec![
        Op::GroupBegin {
            composited: true,
            matrix: None,
            bbox: None,
        },
        Op::FormBegin {
            matrix: None,
            bbox: None,
        },
        path(),
        Op::FormEnd,
        Op::GroupEnd,
        path(),
    ]))
    .unwrap();
    assert_eq!(kinds(&composited), [(4, "transparency".into(), true)]);
    assert_eq!(composited.paths.len(), 1);
}

#[test]
fn issue_4406_hidden_optional_content_and_raster_only_verdicts() {
    let hidden = prepare_pdf_vector_page(&page(vec![
        Op::MarkedContent { visible: false },
        Op::MarkedContent { visible: true },
        path(),
        Op::Text {
            quad: [20., 30., 40., 30., 40., 35., 20., 35.],
            invisible: false,
        },
        Op::EndMarkedContent,
        Op::EndMarkedContent,
        Op::EndMarkedContent,
        Op::Image {
            transforms: vec![[100., 0., 0., 100., 10., 20.]],
        },
    ]))
    .unwrap();
    assert!(hidden.paths.is_empty());
    assert_eq!(kinds(&hidden), [(4, "hidden".into(), false), (6, "text".into(), false), (14, "image".into(), true)]);
    assert_eq!(hidden.fidelity.omitted_paints, 0, "hidden paint is listed but not counted as an omitted paint");
    assert!(hidden.fidelity.raster_only, "only the raster image is visible");
    assert!(!hidden.fidelity.exact);
    assert_eq!(hidden.fidelity.describe(), "raster-only page");
    let mixed = prepare_pdf_vector_page(&page(vec![
        Op::Image {
            transforms: vec![[100., 0., 0., 100., 10., 20.]],
        },
        path(),
    ]))
    .unwrap();
    assert!(!mixed.fidelity.raster_only && !mixed.fidelity.exact);
    let blank = prepare_pdf_vector_page(&page(vec![])).unwrap();
    assert!(blank.fidelity.exact && !blank.fidelity.raster_only);
    assert_eq!(blank.fidelity.convertible_paths, 0);
}

#[test]
fn issue_4406_graphics_state_dictionary_applies_line_state_and_taints_transparency() {
    let report = prepare_pdf_vector_page(&page(vec![
        Op::Save,
        Op::GraphicsState {
            line_width: Some(4.),
            line_cap: Some(2),
            line_join: Some(2),
            miter_limit: Some(3.),
            dash: None,
            transparency: vec![],
            unsupported: vec![],
        },
        path(),
        gstate(&["ca"], &[]),
        path(),
        Op::Restore,
        path(),
    ]))
    .unwrap();
    assert_eq!(report.paths.len(), 2);
    let first = &report.paths[0].state;
    assert_eq!((first.line_width, first.line_cap, first.line_join, first.miter_limit), (4., 2, 2, 3.));
    assert_eq!(kinds(&report), [(8, "transparency".into(), true)]);
    assert_eq!(report.paths[1].state.line_width, 1.);
    let unsupported = prepare_pdf_vector_page(&page(vec![gstate(&[], &["TR"]), path()])).unwrap();
    assert_eq!(
        kinds(&unsupported),
        [(0, "unsupported:setGState:TR".into(), true), (2, "unsupported:setGState:TR".into(), true)]
    );
    assert!(prepare_pdf_vector_page(&page(vec![Op::GraphicsState {
        line_width: None,
        line_cap: Some(9),
        line_join: None,
        miter_limit: None,
        dash: None,
        transparency: vec![],
        unsupported: vec![],
    }]))
    .is_err());
}

#[test]
fn issue_4406_stroke_features_and_pattern_colours_split_combined_paints() {
    let combined = |paint| Op::Path {
        paint,
        commands: rect(20., 30., 10., 10.),
    };
    let report = prepare_pdf_vector_page(&page(vec![
        Op::Dash {
            lengths: vec![4., 2.],
            phase: 1.,
        },
        combined(PdfVectorPaint::CloseEvenOddFillStroke),
        Op::Dash {
            lengths: vec![],
            phase: 0.,
        },
        Op::LineCap { cap: 1 },
        combined(PdfVectorPaint::Stroke),
        Op::LineCap { cap: 0 },
        Op::Path {
            paint: PdfVectorPaint::Stroke,
            commands: vec![0., 20., 30., 2., 25., 40., 30., 40., 35., 30.],
        },
        Op::StrokePattern,
        combined(PdfVectorPaint::FillStroke),
        Op::StrokeColor { rgb: [0., 0., 1.] },
        Op::FillPattern,
        combined(PdfVectorPaint::CloseFillStroke),
        Op::FillColor { rgb: [1., 0., 0.] },
        combined(PdfVectorPaint::FillStroke),
    ]))
    .unwrap();
    let paints: Vec<_> = report.paths.iter().map(|p| (p.operator_ordinal, p.paint)).collect();
    assert_eq!(
        paints,
        [
            (2, PdfVectorPaint::EvenOddFill),
            (16, PdfVectorPaint::Fill),
            (22, PdfVectorPaint::CloseStroke),
            (26, PdfVectorPaint::FillStroke),
        ]
    );
    assert_eq!(
        kinds(&report),
        [
            (2, "dash".into(), true),
            (8, "roundCapJoin".into(), true),
            (12, "curvedStroke".into(), true),
            (16, "pattern".into(), true),
            (22, "pattern".into(), true),
        ]
    );
    assert_eq!(report.fidelity.omitted_paints, 5);
    assert_eq!(report.fidelity.convertible_paths, 4);
}

#[test]
fn issue_4406_unsupported_operator_taints_the_rest_of_its_scope_by_name() {
    let report = prepare_pdf_vector_page(&page(vec![
        Op::Save,
        Op::Unsupported {
            operator: "setFillTransparent".into(),
        },
        path(),
        Op::Restore,
        path(),
    ]))
    .unwrap();
    assert_eq!(
        kinds(&report),
        [
            (2, "unsupported:setFillTransparent".into(), true),
            (4, "unsupported:setFillTransparent".into(), true)
        ]
    );
    assert_eq!(report.paths.len(), 1);
    assert_eq!(report.fidelity.omitted_paints, 1);
}

#[test]
fn issue_4406_annotation_appearance_is_one_omission_and_resets_state() {
    // Page-level state (a transform outside any save) does not leak into the
    // appearance or past it; the explicit stack is balanced when it begins.
    let report = prepare_pdf_vector_page(&page(vec![
        Op::Transform {
            matrix: [2., 0., 0., 2., 0., 0.],
        },
        Op::Save,
        Op::LineWidth { width: 5. },
        Op::Restore,
        Op::AnnotationBegin {
            rect: Some([20., 30., 40., 50.]),
        },
        Op::Transform {
            matrix: [1., 0., 0., 1., 5., 5.],
        },
        path(),
        Op::Text {
            quad: [0., 0., 1., 0., 1., 1., 0., 1.],
            invisible: false,
        },
        Op::AnnotationEnd,
        path(),
    ]))
    .unwrap();
    assert_eq!(kinds(&report), [(8, "annotation".into(), true)]);
    assert_eq!(report.fidelity.omissions[0].bbox_pdf, Some([20., 30., 40., 50.]));
    assert_eq!(report.paths.len(), 1);
    assert_eq!(report.paths[0].operator_ordinal, 18);
    assert_eq!(report.paths[0].state.model_metres_from_path, page(vec![]).model_metres_from_pdf);
    assert_eq!(report.paths[0].state.line_width, 1.);
    let outside = prepare_pdf_vector_page(&page(vec![
        Op::AnnotationBegin {
            rect: Some([500., 500., 600., 600.]),
        },
        Op::AnnotationEnd,
        path(),
    ]))
    .unwrap();
    assert!(outside.fidelity.exact);
}

#[test]
fn issue_4406_scope_mismatches_and_unbounded_placements_refuse_atomically() {
    for ops in [
        vec![
            Op::FormBegin {
                matrix: None,
                bbox: None,
            },
            Op::Restore,
        ],
        vec![Op::FormEnd],
        vec![Op::GroupEnd],
        vec![Op::Save, Op::FormEnd],
        vec![Op::AnnotationEnd],
        vec![Op::Image {
            transforms: vec![],
        }],
        vec![Op::Image {
            transforms: vec![[1., 0., 0., 1., 0., 0.]; 4097],
        }],
        vec![Op::FormBegin {
            matrix: Some([0., 0., 0., 0., 0., 0.]),
            bbox: None,
        }],
        vec![Op::AnnotationBegin {
            rect: Some([10., 10., 0., 0.]),
        }],
        vec![Op::Unsupported {
            operator: String::new(),
        }],
        // A dangling save is refused whether or not an annotation follows it;
        // the pinned decoder closes pending restores before annotations.
        vec![Op::Save],
        vec![
            Op::Save,
            Op::AnnotationBegin { rect: None },
            Op::AnnotationEnd,
        ],
        vec![Op::AnnotationBegin { rect: None }, Op::Save, Op::AnnotationEnd],
        vec![
            Op::AnnotationBegin { rect: None },
            Op::FormBegin {
                matrix: None,
                bbox: None,
            },
            Op::AnnotationEnd,
        ],
    ] {
        assert!(prepare_pdf_vector_page(&page(ops)).is_err());
    }
    // Hidden forms neither save nor restore, exactly like the pinned canvas.
    let hidden_form = prepare_pdf_vector_page(&page(vec![
        Op::MarkedContent { visible: false },
        Op::FormBegin {
            matrix: None,
            bbox: None,
        },
        Op::FormEnd,
        Op::EndMarkedContent,
        path(),
    ]))
    .unwrap();
    assert_eq!(hidden_form.paths.len(), 1);
}

#[test]
fn issue_4406_listed_omissions_are_bounded_while_summary_counts_stay_complete() {
    let mut ops = vec![Op::LineWidth { width: 0. }];
    ops.extend(std::iter::repeat_n(path(), MAX_LISTED_OMISSIONS + 4));
    let report = prepare_pdf_vector_page(&page(ops)).unwrap();
    assert_eq!(report.fidelity.omissions.len(), MAX_LISTED_OMISSIONS);
    assert!(report.fidelity.omissions_truncated);
    assert_eq!(report.fidelity.summary[0].count as usize, MAX_LISTED_OMISSIONS + 4);
    assert_eq!(report.fidelity.omitted_paints as usize, MAX_LISTED_OMISSIONS + 4);
}
