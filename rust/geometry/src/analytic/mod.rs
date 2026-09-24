// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact source descriptions for IFC geometry, in representation-local IFC units.
//! A description does not claim to include later boolean operations.

mod curve;
mod helpers;
#[cfg(test)]
mod tests;

use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// An ordered directrix primitive. Angles are radians in the circle's local frame.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AnalyticCurveSegment {
    Line {
        start: [f64; 3],
        end: [f64; 3],
    },
    Arc {
        center: [f64; 3],
        normal: [f64; 3],
        x_axis: [f64; 3],
        radius: f64,
        start_angle: f64,
        sweep_angle: f64,
    },
}

impl AnalyticCurveSegment {
    fn is_finite(&self) -> bool {
        match self {
            Self::Line { start, end } => start.iter().chain(end).all(|v| v.is_finite()),
            Self::Arc {
                center,
                normal,
                x_axis,
                radius,
                start_angle,
                sweep_angle,
            } => {
                center
                    .iter()
                    .chain(normal)
                    .chain(x_axis)
                    .all(|v| v.is_finite())
                    && radius.is_finite()
                    && *radius > 0.0
                    && start_angle.is_finite()
                    && sweep_angle.is_finite()
            }
        }
    }

    /// Reverse traversal without changing the underlying circle frame.
    pub fn reversed(&self) -> Self {
        match *self {
            Self::Line { start, end } => Self::Line {
                start: end,
                end: start,
            },
            Self::Arc {
                center,
                normal,
                x_axis,
                radius,
                start_angle,
                sweep_angle,
            } => Self::Arc {
                center,
                normal,
                x_axis,
                radius,
                start_angle: start_angle + sweep_angle,
                sweep_angle: -sweep_angle,
            },
        }
    }

    /// Restrict this segment to a fraction of its parameter interval.
    pub fn subsegment(&self, start: f64, end: f64) -> Self {
        match *self {
            Self::Line { start: a, end: b } => {
                let p = |t: f64| std::array::from_fn(|i| a[i] + (b[i] - a[i]) * t);
                Self::Line {
                    start: p(start),
                    end: p(end),
                }
            }
            Self::Arc {
                center,
                normal,
                x_axis,
                radius,
                start_angle,
                sweep_angle,
            } => Self::Arc {
                center,
                normal,
                x_axis,
                radius,
                start_angle: start_angle + sweep_angle * start,
                sweep_angle: sweep_angle * (end - start),
            },
        }
    }
}

/// Whether every part of the authored directrix has an exact supported form.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "reason", rename_all = "snake_case")]
pub enum AnalyticStatus {
    Complete,
    Unsupported(String),
}

/// The authored `IfcSweptDiskSolid` before any enclosing boolean operation.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AnalyticSweptDisk {
    pub directrix_id: u32,
    pub radius: f64,
    pub inner_radius: Option<f64>,
    pub segments: Vec<AnalyticCurveSegment>,
    pub status: AnalyticStatus,
}

/// Extract an exact directrix where supported. Unsupported curve types return a
/// status and no partial segments; malformed required attributes return an error.
pub fn extract_swept_disk(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<AnalyticSweptDisk> {
    if entity.ifc_type != IfcType::IfcSweptDiskSolid {
        return Err(Error::geometry("expected IfcSweptDiskSolid".to_string()));
    }
    let directrix_id = entity
        .get_ref(0)
        .ok_or_else(|| Error::geometry("IfcSweptDiskSolid missing Directrix".to_string()))?;
    let radius = entity
        .get_float(1)
        .filter(|r| r.is_finite() && *r > 0.0)
        .ok_or_else(|| Error::geometry("IfcSweptDiskSolid has invalid Radius".to_string()))?;
    let inner_radius = entity.get_float(2);
    if inner_radius.is_some_and(|r| !r.is_finite() || r <= 0.0 || r >= radius) {
        return Err(Error::geometry(
            "IfcSweptDiskSolid has invalid InnerRadius".to_string(),
        ));
    }
    let directrix = decoder
        .resolve_ref(entity.get(0).unwrap())?
        .ok_or_else(|| {
            Error::geometry("IfcSweptDiskSolid Directrix cannot be resolved".to_string())
        })?;
    let mut walk = curve::CurveWalk::default();
    let start = entity.get_float(3);
    let end = entity.get_float(4);
    let has_trim = start.is_some() || end.is_some();
    let extracted = if directrix.ifc_type == IfcType::IfcLine && (start.is_none() || end.is_none())
    {
        None // An unbounded IfcLine has no authored finite swept extent.
    } else if has_trim && directrix.ifc_type.is_subtype_of(IfcType::IfcCompositeCurve) {
        walk.composite_trimmed(&directrix, decoder, start, end)?
    } else {
        walk.extract(&directrix, decoder)?
    };
    let (mut segments, mut status) = match extracted {
        Some(segments) => (segments, AnalyticStatus::Complete),
        None => (
            Vec::new(),
            AnalyticStatus::Unsupported(format!(
                "unsupported directrix {}",
                directrix.ifc_type.as_str()
            )),
        ),
    };
    if start.is_some_and(|v| !v.is_finite()) || end.is_some_and(|v| !v.is_finite()) {
        return Err(Error::geometry(
            "IfcSweptDiskSolid has non-finite trim parameter".to_string(),
        ));
    }
    if matches!(status, AnalyticStatus::Complete) && has_trim {
        match directrix.ifc_type {
            IfcType::IfcPolyline => {
                segments = helpers::trim_indexed_segments(&segments, start, end)?;
            }
            IfcType::IfcCompositeCurve | IfcType::IfcCompositeCurveOnSurface => {}
            IfcType::IfcTrimmedCurve => {
                if !trimmed_line_solid_bounds_redundant(&directrix, &segments, start, end, decoder)?
                {
                    status = AnalyticStatus::Unsupported(
                        "solid-level trim on trimmed directrix is not redundant".to_string(),
                    );
                }
            }
            IfcType::IfcCircle => {
                let scale = decoder.plane_angle_to_radians();
                if !scale.is_finite() || scale <= 0.0 {
                    return Err(Error::geometry(
                        "invalid plane angle unit scale".to_string(),
                    ));
                }
                let begin = start.unwrap_or(0.0) * scale;
                let finish = end.unwrap_or(std::f64::consts::TAU / scale) * scale;
                let mut sweep = finish - begin;
                if sweep < 0.0 {
                    sweep += std::f64::consts::TAU;
                }
                if !begin.is_finite()
                    || !sweep.is_finite()
                    || sweep <= 0.0
                    || sweep > std::f64::consts::TAU + 1e-9
                {
                    status = AnalyticStatus::Unsupported(
                        "invalid circular directrix parameter range".to_string(),
                    );
                } else if let Some(AnalyticCurveSegment::Arc {
                    start_angle,
                    sweep_angle,
                    ..
                }) = segments.first_mut()
                {
                    *start_angle = begin;
                    *sweep_angle = sweep;
                }
            }
            IfcType::IfcLine => {
                // An IfcLine parameter is distance along its IfcVector, not a
                // normalized segment fraction. The extractor's bare line spans 0..1.
                let line = segments
                    .first()
                    .cloned()
                    .ok_or_else(|| Error::geometry("empty line".to_string()))?;
                segments = vec![line.subsegment(start.unwrap_or(0.0), end.unwrap_or(1.0))];
            }
            _ => {
                status = AnalyticStatus::Unsupported(
                    "solid-level trim for this directrix is unsupported".to_string(),
                )
            }
        }
    }
    if matches!(status, AnalyticStatus::Complete)
        && segments.iter().any(|segment| !segment.is_finite())
    {
        return Err(Error::geometry(
            "analytic directrix has non-finite geometry".to_string(),
        ));
    }
    if matches!(status, AnalyticStatus::Complete) && segments.is_empty() {
        status = AnalyticStatus::Unsupported("directrix has no segments".to_string());
    }
    if !matches!(status, AnalyticStatus::Complete) {
        segments.clear();
    }
    Ok(AnalyticSweptDisk {
        directrix_id,
        radius,
        inner_radius,
        segments,
        status,
    })
}

/// The mesh path ignores solid-level bounds on an `IfcTrimmedCurve`. Keep a
/// complete analytic description only when those bounds select its existing
/// trimmed line endpoints, so the description agrees with the rendered solid.
fn trimmed_line_solid_bounds_redundant(
    directrix: &DecodedEntity,
    segments: &[AnalyticCurveSegment],
    start: Option<f64>,
    end: Option<f64>,
    decoder: &mut EntityDecoder,
) -> Result<bool> {
    let (Some(start), Some(end), [AnalyticCurveSegment::Line { start: a, end: b }]) =
        (start, end, segments)
    else {
        return Ok(false);
    };
    let Some(basis_attr) = directrix.get(0) else {
        return Ok(false);
    };
    let Some(basis) = decoder.resolve_ref(basis_attr)? else {
        return Ok(false);
    };
    if basis.ifc_type != IfcType::IfcLine {
        return Ok(false);
    }
    let (_, direction) = helpers::line_basis(&basis, decoder)?;
    let magnitude = (direction.iter().map(|v| v * v).sum::<f64>()).sqrt();
    if magnitude <= 1e-12 {
        return Ok(false);
    }
    let span = a
        .iter()
        .zip(b)
        .map(|(x, y)| (y - x) * (y - x))
        .sum::<f64>()
        .sqrt()
        / magnitude;
    let close = |x: f64, y: f64| (x - y).abs() <= 1e-8 * x.abs().max(y.abs()).max(1.0);
    // IfcTrimmedCurve's own domain starts at zero, independent of where its
    // Trim1 lies on the basis curve. Solid bounds are relative to that domain.
    Ok(close(start, 0.0) && close(end, span))
}
