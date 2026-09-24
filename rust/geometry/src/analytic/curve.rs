// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::helpers::*;
use super::AnalyticCurveSegment as Segment;
use crate::{Error, Result};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::{collections::HashSet, f64::consts::TAU};

const MAX_VISITS: usize = 100_000;
const MAX_DEPTH: usize = 128;

#[derive(Default)]
pub(super) struct CurveWalk {
    path: HashSet<u32>,
    visits: usize,
}

impl CurveWalk {
    pub(super) fn extract(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<Segment>>> {
        self.visits += 1;
        if self.visits > MAX_VISITS || self.path.len() >= MAX_DEPTH {
            return Err(Error::geometry(
                "analytic curve traversal exceeded work bound".to_string(),
            ));
        }
        if !self.path.insert(curve.id) {
            return Err(Error::geometry(
                "analytic curve reference cycle".to_string(),
            ));
        }
        let result = self.extract_inner(curve, decoder);
        self.path.remove(&curve.id);
        if let Ok(Some(ref pieces)) = result {
            self.visits = self.visits.saturating_add(pieces.len());
            if self.visits > MAX_VISITS {
                return Err(Error::geometry(
                    "analytic curve output exceeded work bound".to_string(),
                ));
            }
        }
        result
    }

    fn extract_inner(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<Segment>>> {
        match curve.ifc_type {
            IfcType::IfcPolyline => self.polyline(curve, decoder).map(Some),
            IfcType::IfcIndexedPolyCurve => self.indexed(curve, decoder),
            IfcType::IfcCompositeCurve | IfcType::IfcCompositeCurveOnSurface => {
                self.composite(curve, decoder)
            }
            IfcType::IfcTrimmedCurve => self.trimmed(curve, decoder),
            IfcType::IfcLine => Ok(Some(vec![line(curve, decoder, 0.0, 1.0)?])),
            IfcType::IfcCircle => {
                let (center, normal, x_axis, _, radius) = circle_basis(curve, decoder)?;
                Ok(Some(vec![Segment::Arc {
                    center,
                    normal,
                    x_axis,
                    radius,
                    start_angle: 0.0,
                    sweep_angle: TAU,
                }]))
            }
            _ => Ok(None),
        }
    }

    fn polyline(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Segment>> {
        let refs = curve
            .get_list(0)
            .ok_or_else(|| invalid("Polyline missing Points"))?;
        if refs.len() > MAX_VISITS {
            return Err(invalid("Polyline exceeds work bound"));
        }
        let mut points = Vec::with_capacity(refs.len());
        for reference in refs {
            points.push(point_from_ref(reference, decoder)?);
        }
        Ok(points
            .windows(2)
            .map(|w| Segment::Line {
                start: w[0],
                end: w[1],
            })
            .collect())
    }

    fn indexed(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<Segment>>> {
        let points_entity = resolve(curve.get(0), decoder)?;
        let coords = points_entity
            .get_list(0)
            .ok_or_else(|| invalid("IndexedPolyCurve missing CoordList"))?;
        if coords.len() > MAX_VISITS {
            return Err(invalid("IndexedPolyCurve exceeds work bound"));
        }
        let points: Vec<_> = coords
            .iter()
            .map(|coord| {
                let values = coord
                    .as_list()
                    .ok_or_else(|| invalid("invalid point list coordinate"))?;
                point_values(values)
            })
            .collect::<Result<_>>()?;
        let mut out = Vec::new();
        if curve.get(1).is_none_or(AttributeValue::is_null) {
            for w in points.windows(2) {
                out.push(Segment::Line {
                    start: w[0],
                    end: w[1],
                });
            }
            return Ok(Some(out));
        }
        let items = curve
            .get_list(1)
            .ok_or_else(|| invalid("invalid IndexedPolyCurve Segments"))?;
        for item in items {
            self.visits += 1;
            if self.visits > MAX_VISITS {
                return Err(invalid("IndexedPolyCurve exceeds work bound"));
            }
            let typed = item
                .as_list()
                .ok_or_else(|| invalid("invalid indexed segment"))?;
            let kind = typed
                .first()
                .and_then(AttributeValue::as_string)
                .unwrap_or("");
            let indices = typed
                .get(1)
                .and_then(AttributeValue::as_list)
                .ok_or_else(|| invalid("invalid indexed segment indices"))?;
            let indexed: Vec<_> = indices
                .iter()
                .map(|value| {
                    let i = value
                        .as_float()
                        .ok_or_else(|| invalid("invalid indexed vertex"))?;
                    if !i.is_finite() || i < 1.0 || i.fract() != 0.0 || i > points.len() as f64 {
                        return Err(invalid("indexed vertex out of range"));
                    }
                    Ok(points[i as usize - 1])
                })
                .collect::<Result<_>>()?;
            match kind {
                "IFCLINEINDEX" => {
                    for w in indexed.windows(2) {
                        out.push(Segment::Line {
                            start: w[0],
                            end: w[1],
                        });
                    }
                }
                "IFCARCINDEX" if indexed.len() == 3 => {
                    let Some(arc) = arc_through(indexed[0], indexed[1], indexed[2]) else {
                        return Ok(None);
                    };
                    out.push(arc);
                }
                _ => return Ok(None),
            }
        }
        Ok(Some(out))
    }

    /// IFC composite parameters concatenate the parameter spans of each
    /// `ParentCurve`. The span of a trimmed line is in its basis vector units;
    /// the span of a trimmed circle is in the project's plane angle units.
    pub(super) fn composite_trimmed(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
        start: Option<f64>,
        end: Option<f64>,
    ) -> Result<Option<Vec<Segment>>> {
        let refs = curve
            .get_list(0)
            .ok_or_else(|| invalid("CompositeCurve missing Segments"))?;
        if refs.len() > MAX_VISITS {
            return Err(invalid("CompositeCurve exceeds work bound"));
        }
        let mut pieces_with_spans = Vec::new();
        let mut total = 0.0;
        for reference in refs {
            let segment = resolve(Some(reference), decoder)?;
            if segment.ifc_type != IfcType::IfcCompositeCurveSegment {
                return Ok(None);
            }
            let parent = resolve(segment.get(2), decoder)?;
            let Some(pieces) = self.extract(&parent, decoder)? else {
                return Ok(None);
            };
            let Some(mut spans) = parent_piece_spans(&parent, &pieces, decoder)? else {
                return Ok(None);
            };
            let same_sense = segment
                .get(1)
                .and_then(AttributeValue::as_enum)
                .unwrap_or("T")
                == "T";
            let pieces: Vec<_> = if same_sense {
                pieces
            } else {
                spans.reverse();
                pieces.into_iter().rev().map(|p| p.reversed()).collect()
            };
            for (piece, span) in pieces.into_iter().zip(spans) {
                if !span.is_finite() || span <= 0.0 {
                    return Ok(None);
                }
                total += span;
                if !total.is_finite() {
                    return Err(invalid("non-finite composite parameter domain"));
                }
                pieces_with_spans.push((piece, span));
            }
        }
        let a = start.unwrap_or(0.0).max(0.0);
        let b = end.unwrap_or(total).min(total);
        if b <= a {
            return Ok(Some(Vec::new()));
        }
        let mut out = Vec::new();
        let mut cursor = 0.0;
        for (piece, span) in pieces_with_spans {
            let left = a.max(cursor);
            let right = b.min(cursor + span);
            if right > left {
                out.push(piece.subsegment((left - cursor) / span, (right - cursor) / span));
            }
            cursor += span;
        }
        Ok(Some(out))
    }

    fn composite(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<Segment>>> {
        let refs = curve
            .get_list(0)
            .ok_or_else(|| invalid("CompositeCurve missing Segments"))?;
        if refs.len() > MAX_VISITS {
            return Err(invalid("CompositeCurve exceeds work bound"));
        }
        let mut out = Vec::new();
        for reference in refs {
            let segment = resolve(Some(reference), decoder)?;
            if segment.ifc_type != IfcType::IfcCompositeCurveSegment {
                return Ok(None);
            }
            let same_sense = segment
                .get(1)
                .and_then(AttributeValue::as_enum)
                .unwrap_or("T")
                == "T";
            let parent = resolve(segment.get(2), decoder)?;
            let Some(mut pieces) = self.extract(&parent, decoder)? else {
                return Ok(None);
            };
            if !same_sense {
                pieces = pieces.into_iter().rev().map(|p| p.reversed()).collect();
            }
            out.extend(pieces);
        }
        Ok(Some(out))
    }

    fn trimmed(
        &mut self,
        curve: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<Segment>>> {
        let basis = resolve(curve.get(0), decoder)?;
        let sense = curve
            .get(3)
            .and_then(AttributeValue::as_enum)
            .unwrap_or("T")
            == "T";
        let cartesian = curve.get(4).and_then(AttributeValue::as_enum).unwrap_or("") == "CARTESIAN";
        match basis.ifc_type {
            IfcType::IfcLine => {
                let (origin, direction) = line_basis(&basis, decoder)?;
                let Some(start) = trim_point(curve.get(1), origin, direction, cartesian, decoder)?
                else {
                    return Ok(None);
                };
                let Some(end) = trim_point(curve.get(2), origin, direction, cartesian, decoder)?
                else {
                    return Ok(None);
                };
                Ok(Some(vec![Segment::Line { start, end }]))
            }
            IfcType::IfcCircle => {
                let (center, normal, x_axis, y_axis, radius) = circle_basis(&basis, decoder)?;
                let Some(start) =
                    trim_angle(curve.get(1), center, x_axis, y_axis, cartesian, decoder)?
                else {
                    return Ok(None);
                };
                let Some(end) =
                    trim_angle(curve.get(2), center, x_axis, y_axis, cartesian, decoder)?
                else {
                    return Ok(None);
                };
                let mut sweep = (end - start).rem_euclid(TAU);
                if !sense {
                    sweep -= TAU;
                }
                if sweep.abs() < 1e-12 {
                    sweep = if sense { TAU } else { -TAU };
                }
                Ok(Some(vec![Segment::Arc {
                    center,
                    normal,
                    x_axis,
                    radius,
                    start_angle: start,
                    sweep_angle: sweep,
                }]))
            }
            _ => Ok(None),
        }
    }
}
