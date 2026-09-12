// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Painted-path visibility, fidelity reporting and bounded selection.
use super::*;

impl Interpreter {
    pub(super) fn path(
        &mut self,
        ordinal: u32,
        paint: PdfVectorPaint,
        commands: &[f64],
    ) -> Result<(), String> {
        self.numbers += commands.len();
        if self.numbers > MAX_PATH_NUMBERS {
            return Err("PDF paths exceed two million numbers".into());
        }
        validate_path(commands)?;
        // Empty paths/endPath consume no visible paint. In particular an
        // unused zero-width setting does not itself paint a hairline.
        let painted = paint != PdfVectorPaint::EndPath && !commands.is_empty();
        if painted && !self.annotation {
            let mut bbox = extent::bbox(extent::path_points(commands).map(|p| self.to_pdf(p)));
            // Visibility and crop containment apply to painted ink, not only
            // the path centreline. This deliberately overbounds joins/caps:
            // an uncertain boundary contact refuses instead of losing paint.
            if paint.strokes() && self.frame.state.line_width > 0. {
                if let Some([mut x0, mut y0, mut x1, mut y1]) = bbox {
                    let [a, b, c, d, _, _] = self.frame.pdf_from_path;
                    let points = extent::path_points(commands).count();
                    let closed = paint.closes() || extent::opcodes(commands).any(|op| op == 4);
                    let joined = points > 2 || closed;
                    let join_factor = if joined && self.frame.state.line_join == 0 {
                        self.frame.state.miter_limit.max(1.)
                    } else {
                        1.
                    };
                    let cap_factor = if !closed && self.frame.state.line_cap == 2 {
                        2.
                    } else {
                        1.
                    };
                    let half = self.frame.state.line_width * join_factor.max(cap_factor) / 2.;
                    let (mx, my) = (half * a.hypot(c), half * b.hypot(d));
                    x0 -= mx;
                    x1 += mx;
                    y0 -= my;
                    y1 += my;
                    bbox = Some([x0, y0, x1, y1]);
                }
            }
            if self.hidden > 0 {
                self.report.record("hidden", ordinal, bbox, false, true);
            } else {
                self.record_visible_path(ordinal, paint, commands, bbox)?;
            }
        }
        // PDF paints first, then intersects the pending clip with the same path.
        if self.pending_clip {
            self.pending_clip = false;
            self.consume_clip(commands);
        }
        Ok(())
    }

    fn record_visible_path(
        &mut self,
        ordinal: u32,
        paint: PdfVectorPaint,
        commands: &[f64],
        bbox: Option<Rect>,
    ) -> Result<(), String> {
        // A PDF hairline has device-dependent minimum width. Without an
        // authenticated target raster, an interior selection cannot prove that
        // an outside centreline contributes no pixels.
        let uncertain_hairline =
            self.conversion_clip && paint.strokes() && self.frame.state.line_width == 0.;
        let visible = uncertain_hairline || bbox.is_some_and(|b| extent::intersects(&b, &self.clip));
        let fill_block = paint
            .fills()
            .then(|| self.state_block(self.frame.taint.fill_pattern))
            .flatten();
        let stroke_block = paint
            .strokes()
            .then(|| self.stroke_block(commands, paint.closes()))
            .flatten();
        let kept = match (paint.fills(), paint.strokes(), &fill_block, &stroke_block) {
            (true, true, None, None) | (true, false, None, _) | (false, true, _, None) => Some(paint),
            (true, true, None, Some(_)) => Some(paint.fill_only()),
            (true, true, Some(_), None) => Some(paint.stroke_only()),
            _ => None,
        };
        if self.conversion_clip && visible {
            if let (Some(_), Some([x0, y0, x1, y1])) = (kept, bbox) {
                if x0 < self.clip[0] || y0 < self.clip[1]
                    || x1 > self.clip[2] || y1 > self.clip[3]
                {
                    return Err(format!(
                        "PDF operator {ordinal}: conversion boundary crosses painted path; choose a crop through empty space"
                    ));
                }
            }
        }
        if let Some(kind) = &fill_block {
            self.report.record(kind, ordinal, bbox, visible, true);
        }
        if let Some(kind) = &stroke_block {
            if fill_block.as_ref() != Some(kind) {
                self.report.record(kind, ordinal, bbox, visible, true);
            }
        }
        if visible || !self.conversion_clip {
            if let Some(paint) = kept {
                if self.paths.len() == MAX_PATHS {
                    return Err("PDF page exceeds 20000 painted paths".into());
                }
                self.paths.push(PreparedPdfVectorPath {
                    operator_ordinal: ordinal,
                    paint,
                    commands: commands.to_vec(),
                    state: self.frame.state.clone(),
                    dash_closure: if paint.strokes()
                        && !self.frame.state.dash_lengths.is_empty()
                        && (paint.closes() || extent::opcodes(commands).any(|op| op == 4))
                    {
                        self.dash_closure
                    } else {
                        None
                    },
                });
            }
        }
        Ok(())
    }
}
