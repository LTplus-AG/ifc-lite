// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Decoder-neutral ordered input. These are decoded operations, not a PDF parser.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfVectorPage {
    pub pdf_sha256: String,
    pub decoder_version: String,
    pub page_number: u32,
    /// Unrotated native PDF user-space CropBox.
    pub view_box: [f64; 4],
    pub user_unit: f64,
    pub intrinsic_rotation: u16,
    /// Host calibration maps native PDF coordinates to the annotation plane in
    /// model metres. It already includes the chosen crop/rotation/UserUnit/scale.
    pub model_metres_from_pdf: [f64; 6],
    pub calibration_key: String,
    /// Declared downstream curve-flattening tolerance, not a fidelity claim yet.
    pub tolerance_metres: f64,
    pub operations: Vec<PdfVectorOperation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfVectorOperation {
    /// Original PDF.js operator-list index, strictly increasing (gaps allowed).
    pub ordinal: u32,
    pub operation: PdfVectorOperator,
}

/// One pinned-decoder operation. Geometry kinds carry construction-space
/// numbers; semantic kinds carry exactly what the fidelity report needs to
/// scope, place and classify content the planner cannot convert.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PdfVectorOperator {
    Save,
    Restore,
    Transform {
        matrix: [f64; 6],
    },
    FillColor {
        rgb: [f64; 3],
    },
    StrokeColor {
        rgb: [f64; 3],
    },
    LineWidth {
        width: f64,
    },
    LineCap {
        cap: u8,
    },
    LineJoin {
        join: u8,
    },
    MiterLimit {
        limit: f64,
    },
    Dash {
        lengths: Vec<f64>,
        phase: f64,
    },
    Path {
        paint: PdfVectorPaint,
        commands: Vec<f64>,
    },
    /// Pending clip consumed by the next path, after that path's own paint.
    #[serde(rename_all = "camelCase")]
    Clip {
        even_odd: bool,
    },
    /// Painted text was added to the clip at ET; the rest of the scope is clipped.
    TextClip,
    /// One text run. `quad` is its estimated em-box in construction space
    /// (before the current transform); `invisible` is text render mode 3/7.
    Text {
        quad: [f64; 8],
        invisible: bool,
    },
    /// Raster paint. Each transform maps the unit square in construction space.
    Image {
        transforms: Vec<[f64; 6]>,
    },
    /// `sh` paints the current clip with a shading; its extent is the clip.
    Shading,
    FillPattern,
    StrokePattern,
    /// Decoded ExtGState dictionary. Supported line state applies in PDF.js
    /// order; alpha/blend/soft-mask entries taint the scope as transparency.
    #[serde(rename_all = "camelCase")]
    GraphicsState {
        line_width: Option<f64>,
        line_cap: Option<u8>,
        line_join: Option<u8>,
        miter_limit: Option<f64>,
        dash: Option<(Vec<f64>, f64)>,
        transparency: Vec<String>,
        unsupported: Vec<String>,
    },
    /// Transparency group wrapping a form. `composited` means PDF.js renders
    /// it through an offscreen group rather than painting directly.
    GroupBegin {
        composited: bool,
        matrix: Option<[f64; 6]>,
        bbox: Option<[f64; 4]>,
    },
    GroupEnd,
    /// Form XObject: implicit save, matrix concatenation and bbox clip.
    FormBegin {
        matrix: Option<[f64; 6]>,
        bbox: Option<[f64; 4]>,
    },
    FormEnd,
    /// Annotation appearance stream; `rect` is in page space.
    AnnotationBegin {
        rect: Option<[f64; 4]>,
    },
    AnnotationEnd,
    /// Marked content; `visible` resolves optional-content configuration.
    MarkedContent {
        visible: bool,
    },
    EndMarkedContent,
    /// Decoder has encountered semantics outside the qualified subset. The
    /// operation and everything painted afterwards in its scope is omitted.
    Unsupported {
        operator: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PdfVectorPaint {
    Stroke,
    CloseStroke,
    Fill,
    EvenOddFill,
    FillStroke,
    EvenOddFillStroke,
    CloseFillStroke,
    CloseEvenOddFillStroke,
    EndPath,
}
impl PdfVectorPaint {
    pub(super) fn strokes(self) -> bool {
        !matches!(self, Self::Fill | Self::EvenOddFill | Self::EndPath)
    }
    pub(super) fn fills(self) -> bool {
        !matches!(self, Self::Stroke | Self::CloseStroke | Self::EndPath)
    }
    pub(super) fn even_odd(self) -> bool {
        matches!(
            self,
            Self::EvenOddFill | Self::EvenOddFillStroke | Self::CloseEvenOddFillStroke
        )
    }
    pub(super) fn closes(self) -> bool {
        matches!(
            self,
            Self::CloseStroke | Self::CloseFillStroke | Self::CloseEvenOddFillStroke
        )
    }
    /// The same paint with its stroke part removed (a combined operator whose
    /// stroke is omitted keeps its fill).
    pub(super) fn fill_only(self) -> Self {
        if self.even_odd() {
            Self::EvenOddFill
        } else {
            Self::Fill
        }
    }
    /// The same paint with its fill part removed.
    pub(super) fn stroke_only(self) -> Self {
        if self.closes() {
            Self::CloseStroke
        } else {
            Self::Stroke
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfVectorGraphicsState {
    /// Keep commands in construction space. A nonuniform stroke must be outlined
    /// there before this complete transform is applied; scalar width is not enough.
    pub model_metres_from_path: [f64; 6],
    pub fill_rgb: [f64; 3],
    pub stroke_rgb: [f64; 3],
    pub line_width: f64,
    pub line_cap: u8,
    pub line_join: u8,
    pub miter_limit: f64,
    pub dash_lengths: Vec<f64>,
    pub dash_phase: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPdfVectorPath {
    pub operator_ordinal: u32,
    pub paint: PdfVectorPaint,
    /// Pinned DrawOPS: 0 move, 1 line, 2 cubic, 3 quadratic, 4 close.
    /// No flattening or contour/fill classification has happened in this report.
    pub commands: Vec<f64>,
    pub state: PdfVectorGraphicsState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPdfVectorPage {
    /// SHA-256 of algorithm ID + canonical typed request JSON. The host must
    /// authenticate decoded operations against the retained original PDF bytes.
    pub request_sha256: String,
    pub algorithm: String,
    pub pdf_sha256: String,
    pub page_number: u32,
    pub calibration_key: String,
    pub tolerance_metres: f64,
    /// Implicit page clipping applies even when the stream has no clip operator.
    pub page_clip_pdf: [f64; 4],
    /// Only paths whose complete graphics state is understood. Everything the
    /// planner would omit is listed in `fidelity`, never here.
    pub paths: Vec<PreparedPdfVectorPath>,
    pub fidelity: super::report::FidelityReport,
}
