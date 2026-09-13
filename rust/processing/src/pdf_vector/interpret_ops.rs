// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Operator dispatch for the ordered interpreter: colour/line state, pending
//! clips, text/image/shading extents, ExtGState dictionaries and the explicit
//! or implicit (form, group, annotation, optional-content) scopes.
use super::super::extent;
use super::super::{multiply, scalar, validate_rgb, PdfVectorOperator as Op};
use super::{validate_rect, Interpreter, Scope};

const MAX_IMAGE_PLACEMENTS: usize = 4096;
const MAX_GSTATE_ENTRIES: usize = 16;

fn name(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || !value.is_ascii() || value.chars().any(char::is_control) {
        return Err(format!("Invalid {what} identity"));
    }
    Ok(())
}

impl Interpreter {
    pub(super) fn operation(&mut self, ordinal: u32, op: &Op) -> Result<(), String> {
        match op {
            Op::Save => self.push(Scope::Explicit)?,
            Op::Restore => self.pop(Scope::Explicit, "restore")?,
            Op::Transform { matrix } => self.concat(matrix)?,
            Op::FillColor { rgb } => {
                validate_rgb(rgb)?;
                self.frame.state.fill_rgb = *rgb;
                self.frame.taint.fill_pattern = false;
            }
            Op::StrokeColor { rgb } => {
                validate_rgb(rgb)?;
                self.frame.state.stroke_rgb = *rgb;
                self.frame.taint.stroke_pattern = false;
            }
            Op::LineWidth { width } => {
                scalar(*width, 0., 1e9)?;
                self.frame.state.line_width = *width;
            }
            Op::LineCap { cap } => self.set_cap(*cap)?,
            Op::LineJoin { join } => self.set_join(*join)?,
            Op::MiterLimit { limit } => {
                scalar(*limit, 1., 1e9)?;
                self.frame.state.miter_limit = *limit;
            }
            Op::Dash { lengths, phase } => self.set_dash(lengths, *phase)?,
            Op::Path { paint, commands } => self.path(ordinal, *paint, commands)?,
            Op::Clip { .. } => self.pending_clip = true,
            Op::TextClip => self.frame.taint.clip = true,
            Op::Text { quad, invisible } => {
                for x in quad {
                    scalar(*x, -1e9, 1e9)?;
                }
                if !self.annotation {
                    let bbox = extent::bbox(quad.chunks_exact(2).map(|c| self.to_pdf([c[0], c[1]])));
                    let visible = !invisible && self.hidden == 0 && bbox.is_some_and(|b| extent::intersects(&b, &self.clip));
                    self.report.record("text", ordinal, bbox, visible, false);
                }
            }
            Op::Image { transforms } => {
                if transforms.is_empty() || transforms.len() > MAX_IMAGE_PLACEMENTS {
                    return Err("PDF image placement list is empty or exceeds 4096 entries".into());
                }
                for t in transforms {
                    for x in t {
                        scalar(*x, -1e12, 1e12)?;
                    }
                }
                if !self.annotation {
                    let m = self.frame.pdf_from_path;
                    let bbox = extent::bbox(
                        transforms
                            .iter()
                            .flat_map(|t| extent::unit_square_corners(&multiply(&m, t))),
                    );
                    let visible = self.hidden == 0 && bbox.is_some_and(|b| extent::intersects(&b, &self.clip));
                    self.report.record("image", ordinal, bbox, visible, false);
                }
            }
            Op::Shading => {
                if !self.annotation {
                    self.report.record("pattern", ordinal, Some(self.clip), self.hidden == 0, false);
                }
            }
            Op::FillPattern => self.frame.taint.fill_pattern = true,
            Op::StrokePattern => self.frame.taint.stroke_pattern = true,
            Op::GraphicsState {
                line_width,
                line_cap,
                line_join,
                miter_limit,
                dash,
                transparency,
                unsupported,
            } => {
                if transparency.len() + unsupported.len() > MAX_GSTATE_ENTRIES {
                    return Err("PDF graphics-state dictionary exceeds 16 unsupported entries".into());
                }
                if let Some(width) = line_width {
                    scalar(*width, 0., 1e9)?;
                    self.frame.state.line_width = *width;
                }
                if let Some(cap) = line_cap {
                    self.set_cap(*cap)?;
                }
                if let Some(join) = line_join {
                    self.set_join(*join)?;
                }
                if let Some(limit) = miter_limit {
                    scalar(*limit, 1., 1e9)?;
                    self.frame.state.miter_limit = *limit;
                }
                if let Some((lengths, phase)) = dash {
                    self.set_dash(lengths, *phase)?;
                }
                for key in transparency {
                    name(key, "PDF transparency state")?;
                }
                if !transparency.is_empty() {
                    self.frame.taint.transparency = true;
                }
                for key in unsupported {
                    name(key, "PDF graphics-state key")?;
                    self.unsupported(ordinal, &format!("setGState:{key}"));
                }
            }
            Op::GroupBegin { composited, matrix, bbox } => {
                if self.hidden == 0 {
                    self.push(Scope::Group)?;
                    if *composited {
                        self.frame.taint.transparency = true;
                    }
                    if let Some(bbox) = bbox {
                        self.clip_rect(bbox, matrix.as_ref())?;
                    }
                }
            }
            Op::GroupEnd => {
                if self.hidden == 0 {
                    self.pop(Scope::Group, "group end")?;
                }
            }
            Op::FormBegin { matrix, bbox } => {
                if self.hidden == 0 {
                    self.push(Scope::Form)?;
                    if let Some(matrix) = matrix {
                        self.concat(matrix)?;
                    }
                    if let Some(bbox) = bbox {
                        self.clip_rect(bbox, None)?;
                    }
                }
            }
            Op::FormEnd => {
                if self.hidden == 0 {
                    self.pop(Scope::Form, "form end")?;
                }
            }
            Op::AnnotationBegin { rect } => {
                if self.annotation {
                    return Err("PDF annotation begins inside another annotation".into());
                }
                if let Some(rect) = rect {
                    validate_rect(rect)?;
                }
                self.reset("an annotation begin")?;
                self.push(Scope::Annotation)?;
                self.annotation = true;
                let visible = rect.is_none_or(|r| extent::intersects(&r, &self.clip));
                self.report.record("annotation", ordinal, *rect, visible, false);
            }
            Op::AnnotationEnd => {
                if !self.annotation {
                    return Err("PDF annotation end has no matching begin".into());
                }
                if !matches!(self.stack.as_slice(), [(_, Scope::Annotation)]) {
                    return Err("PDF graphics-state stack is unbalanced inside an annotation appearance".into());
                }
                self.stack.clear();
                self.annotation = false;
                self.reset("an annotation end")?;
            }
            Op::MarkedContent { visible } => {
                self.marked.push(*visible);
                if !visible {
                    self.hidden += 1;
                }
            }
            // The pinned canvas tolerates unbalanced marked content; mirror it.
            Op::EndMarkedContent => {
                if self.marked.pop() == Some(false) {
                    self.hidden -= 1;
                }
            }
            Op::Unsupported { operator } => {
                name(operator, "unsupported PDF operator")?;
                self.unsupported(ordinal, operator);
            }
        }
        Ok(())
    }
    fn unsupported(&mut self, ordinal: u32, operator: &str) {
        self.report.record(&format!("unsupported:{operator}"), ordinal, None, self.visible(), false);
        self.frame.taint.unsupported.get_or_insert_with(|| operator.to_owned());
    }
}
