// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Ordered graphics-state interpretation mirroring the pinned PDF.js canvas
//! semantics: explicit and implicit save scopes, optional-content visibility,
//! pending clips and colour/line state. Paths whose state is fully understood
//! become convertible; everything else is recorded as an omission with extent.
use super::extent::{self, Rect};
use super::report::ReportBuilder;
use super::{
    multiply, scalar, validate_matrix, validate_path, PdfDashClosure, PdfVectorGraphicsState,
    PdfVectorPage, PdfVectorPaint, PreparedPdfVectorPath,
};

#[path = "interpret_ops.rs"]
mod ops;
#[path = "interpret_path.rs"]
mod path;

const MAX_PATH_NUMBERS: usize = 2_000_000;
const MAX_PATHS: usize = 20_000;
const MAX_STACK: usize = 64;

#[derive(Clone, Default)]
struct Taint {
    clip: bool,
    transparency: bool,
    fill_pattern: bool,
    stroke_pattern: bool,
    unsupported: Option<String>,
}
#[derive(Clone)]
struct Frame {
    state: PdfVectorGraphicsState,
    /// Construction space to unrotated PDF user space, for extents and clips.
    pdf_from_path: [f64; 6],
    taint: Taint,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    Explicit,
    Form,
    Group,
    Annotation,
}
pub(super) struct Interpreted {
    pub paths: Vec<PreparedPdfVectorPath>,
    pub report: ReportBuilder,
}
struct Interpreter {
    base: Frame,
    frame: Frame,
    stack: Vec<(Frame, Scope)>,
    clip: Rect,
    conversion_clip: bool,
    /// The declared metric tolerance in PDF user-space units under the
    /// calibration's largest scale: a clip may fall short of the page by at
    /// most this strip before the loss counts.
    clip_tolerance_pdf: f64,
    pending_clip: bool,
    marked: Vec<bool>,
    hidden: usize,
    annotation: bool,
    numbers: usize,
    paths: Vec<PreparedPdfVectorPath>,
    report: ReportBuilder,
    dash_closure: Option<PdfDashClosure>,
}

fn dash_closure(version: Option<&str>) -> Option<PdfDashClosure> {
    match version {
        Some("1.0" | "1.1" | "1.2" | "1.3" | "1.4" | "1.5" | "1.6" | "1.7") => {
            Some(PdfDashClosure::Capped)
        }
        Some("2.0") => Some(PdfDashClosure::Joined),
        _ => None,
    }
}

pub(super) fn run(
    page: &PdfVectorPage,
    conversion_clip_pdf: Option<Rect>,
) -> Result<Interpreted, String> {
    let base = Frame {
        state: PdfVectorGraphicsState {
            model_metres_from_path: page.model_metres_from_pdf,
            fill_rgb: [0.; 3],
            stroke_rgb: [0.; 3],
            line_width: 1.,
            line_cap: 0,
            line_join: 0,
            miter_limit: 10.,
            dash_lengths: Vec::new(),
            dash_phase: 0.,
        },
        pdf_from_path: [1., 0., 0., 1., 0., 0.],
        taint: Taint::default(),
    };
    let mut it = Interpreter {
        frame: base.clone(),
        base,
        stack: Vec::new(),
        clip: conversion_clip_pdf.unwrap_or(page.view_box),
        conversion_clip: conversion_clip_pdf.is_some_and(|clip| clip != page.view_box),
        clip_tolerance_pdf: page.tolerance_metres / largest_scale(&page.model_metres_from_pdf),
        pending_clip: false,
        marked: Vec::new(),
        hidden: 0,
        annotation: false,
        numbers: 0,
        paths: Vec::new(),
        report: ReportBuilder::default(),
        dash_closure: dash_closure(page.pdf_format_version.as_deref()),
    };
    let mut previous = None;
    for entry in &page.operations {
        let ordinal = entry.ordinal;
        if previous.is_some_and(|p| p >= ordinal) {
            return Err("PDF operator ordinals must be strictly increasing".into());
        }
        previous = Some(ordinal);
        it.operation(ordinal, &entry.operation)?;
    }
    if !it.stack.is_empty() {
        return Err("PDF graphics-state stack is unbalanced".into());
    }
    Ok(Interpreted {
        paths: it.paths,
        report: it.report,
    })
}

/// Largest singular value of the affine's linear part: the most any PDF
/// length is stretched into model metres.
fn largest_scale(m: &[f64; 6]) -> f64 {
    let (a, b, c, d) = (m[0], m[1], m[2], m[3]);
    let sum = a * a + b * b + c * c + d * d;
    let det = a * d - b * c;
    let discriminant = (sum * sum - 4. * det * det).max(0.).sqrt();
    ((sum + discriminant) / 2.).sqrt().max(f64::MIN_POSITIVE)
}

fn validate_rect(r: &Rect) -> Result<(), String> {
    for x in r {
        scalar(*x, -1e9, 1e9)?;
    }
    if r[0] > r[2] || r[1] > r[3] {
        return Err("PDF rectangle is inverted".into());
    }
    Ok(())
}

impl Interpreter {
    fn push(&mut self, scope: Scope) -> Result<(), String> {
        if self.stack.len() == MAX_STACK {
            return Err("PDF graphics-state stack exceeds 64".into());
        }
        self.stack.push((self.frame.clone(), scope));
        Ok(())
    }
    fn pop(&mut self, scope: Scope, what: &str) -> Result<(), String> {
        match self.stack.last() {
            Some((_, top)) if *top == scope => {
                self.frame = self.stack.pop().unwrap().0;
                self.pending_clip = false;
                Ok(())
            }
            Some(_) => Err(format!("PDF {what} crosses an implicit form, group or annotation scope")),
            None => Err(format!("PDF {what} has no matching save")),
        }
    }
    /// Annotation appearances start from the base state, like the pinned
    /// canvas; the explicit stack must already be balanced (the pinned decoder
    /// closes pending restores at the end of every content stream).
    fn reset(&mut self, what: &str) -> Result<(), String> {
        if !self.stack.is_empty() {
            return Err(format!("PDF graphics-state stack is unbalanced at {what}"));
        }
        self.frame = self.base.clone();
        self.pending_clip = false;
        Ok(())
    }
    fn visible(&self) -> bool {
        self.hidden == 0 && !self.annotation
    }
    fn to_pdf(&self, p: [f64; 2]) -> [f64; 2] {
        extent::apply(&self.frame.pdf_from_path, p)
    }
    fn concat(&mut self, matrix: &[f64; 6]) -> Result<(), String> {
        validate_matrix(matrix)?;
        self.frame.state.model_metres_from_path = multiply(&self.frame.state.model_metres_from_path, matrix);
        self.frame.pdf_from_path = multiply(&self.frame.pdf_from_path, matrix);
        validate_matrix(&self.frame.state.model_metres_from_path)?;
        validate_matrix(&self.frame.pdf_from_path)
    }
    /// The page clip shrunk by the declared tolerance: a clip containing this
    /// inner rectangle removes at most a sub-tolerance strip along the page
    /// edge, which the planner's implicit CropBox clip already bounds.
    fn tolerant_page(&self) -> Rect {
        let t = self.clip_tolerance_pdf;
        let [x0, y0, x1, y1] = self.clip;
        let (cx, cy) = ((x0 + x1) / 2., (y0 + y1) / 2.);
        [(x0 + t).min(cx), (y0 + t).min(cy), (x1 - t).max(cx), (y1 - t).max(cy)]
    }
    /// A rectangle in construction space (optionally under an extra matrix)
    /// that still contains the whole page clip (within tolerance) removes
    /// nothing visible.
    fn clip_rect(&mut self, rect: &Rect, matrix: Option<&[f64; 6]>) -> Result<(), String> {
        validate_rect(rect)?;
        let m = match matrix {
            Some(m) => {
                validate_matrix(m)?;
                multiply(&self.frame.pdf_from_path, m)
            }
            None => self.frame.pdf_from_path,
        };
        let quad = extent::rect_corners(rect).map(|p| extent::apply(&m, p));
        if !extent::quad_contains_rect(&quad, &self.tolerant_page()) {
            self.frame.taint.clip = true;
        }
        Ok(())
    }
    fn consume_clip(&mut self, commands: &[f64]) {
        if let Some(rect) = extent::rectangle_path(commands) {
            let quad = extent::rect_corners(&rect).map(|p| self.to_pdf(p));
            if extent::quad_contains_rect(&quad, &self.tolerant_page()) {
                return;
            }
        }
        self.frame.taint.clip = true;
    }
    fn state_block(&self, pattern: bool) -> Option<String> {
        let taint = &self.frame.taint;
        if taint.clip {
            Some("clip".into())
        } else if taint.transparency {
            Some("transparency".into())
        } else if pattern {
            Some("pattern".into())
        } else {
            taint.unsupported.as_ref().map(|op| format!("unsupported:{op}"))
        }
    }
    fn stroke_block(&self, commands: &[f64], close_last: bool) -> Option<String> {
        if let Some(block) = self.state_block(self.frame.taint.stroke_pattern) {
            return Some(block);
        }
        let s = &self.frame.state;
        if s.line_width == 0. {
            Some("hairline".into())
        } else if !s.dash_lengths.is_empty()
            && !super::dashes::supported(commands, close_last, &s.dash_lengths)
        {
            Some("dash".into())
        } else if !s.dash_lengths.is_empty()
            && (close_last || extent::opcodes(commands).any(|op| op == 4))
            && self.dash_closure.is_none()
        {
            Some("dashVersion".into())
        } else if !s.dash_lengths.is_empty()
            && self.dash_closure == Some(PdfDashClosure::Capped)
            && super::dashes::has_capped_loop(
                commands,
                close_last,
                &s.dash_lengths,
                s.dash_phase,
            )
        {
            Some("dashTopology".into())
        } else if extent::opcodes(commands).any(|op| op == 2 || op == 3) {
            Some("curvedStroke".into())
        } else {
            None
        }
    }
    fn set_dash(&mut self, lengths: &[f64], phase: f64) -> Result<(), String> {
        if lengths.len() > 128 {
            return Err("PDF dash array exceeds 128 entries".into());
        }
        scalar(phase, -1e9, 1e9)?;
        for length in lengths {
            scalar(*length, 0., 1e9)?;
        }
        if !lengths.is_empty() && lengths.iter().all(|x| *x == 0.) {
            return Err("PDF dash array is all zero".into());
        }
        self.frame.state.dash_lengths = lengths.to_vec();
        self.frame.state.dash_phase = phase;
        Ok(())
    }
    fn set_cap(&mut self, cap: u8) -> Result<(), String> {
        if cap > 2 {
            return Err("Invalid PDF line cap".into());
        }
        self.frame.state.line_cap = cap;
        Ok(())
    }
    fn set_join(&mut self, join: u8) -> Result<(), String> {
        if join > 2 {
            return Err("Invalid PDF line join".into());
        }
        self.frame.state.line_join = join;
        Ok(())
    }
}
