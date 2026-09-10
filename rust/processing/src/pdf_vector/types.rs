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
    /// Decoder has encountered semantics outside the qualified subset. Even if
    /// supported paths remain inspectable, the whole page stays unqualified.
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
pub struct PdfVectorDiagnostic {
    pub operator_ordinal: u32,
    pub code: String,
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
    /// Only graphics-state preparation qualification. This is NOT an IFC plan,
    /// geometry fidelity verdict, or permission to publish partial paths.
    pub state_qualified: bool,
    /// Always false for state preparation. No geometry/IFC plan exists yet.
    pub geometry_ready: bool,
    /// Implicit page clipping applies even when the stream has no clip operator.
    pub page_clip_pdf: [f64; 4],
    pub pending_geometry: [&'static str; 5],
    pub paths: Vec<PreparedPdfVectorPath>,
    pub diagnostics: Vec<PdfVectorDiagnostic>,
}
