// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact source descriptions for IFC geometry, in representation-local IFC units.
//! A description does not claim to include later boolean operations.

mod curve;
mod source;
#[cfg(test)]
mod source_tests;
pub use source::{with_source_capture, AnalyticBoundarySource, SourceRecord, SourceValue};
mod owned_directrix;
pub use owned_directrix::{OwnedDirectrix, OwnedRationalCurve};
#[cfg(test)]
mod owned_directrix_tests;
mod frame;
mod helpers;
mod profile;
mod profile_topology;
mod topology_interval;
pub use profile::{extract_analytic_profile, AnalyticProfile, AnalyticProfileLoop, ProfileLoopKind};
mod extrusion;
pub use extrusion::{extract_analytic_extrusion, AnalyticExtrusion};
#[cfg(test)]
mod tests;

use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
pub use frame::{AnalyticPoint, AnalyticSegmentFrame};

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
    /// Original solid-level parameter bounds, before interpretation. Not
    /// serialized: export output stays unchanged.
    #[serde(skip)]
    pub start_param: Option<f64>,
    #[serde(skip)]
    pub end_param: Option<f64>,
    /// Original solid and directrix graph. `None` unless extracted inside
    /// [`with_source_capture`]. Not serialized.
    #[serde(skip)]
    pub source: Option<AnalyticBoundarySource>,
    /// Exact directrix input for an authored consumer, beside the line/arc
    /// `segments`; a rational directrix does not change their `status`.
    /// `None` unless extracted inside [`with_source_capture`]. Not serialized.
    #[serde(skip)]
    pub owned_directrix: Option<OwnedDirectrix>,
    pub radius: f64,
    pub inner_radius: Option<f64>,
    pub segments: Vec<AnalyticCurveSegment>,
    pub status: AnalyticStatus,
}

mod swept_disk;
pub use swept_disk::extract_swept_disk;

/// The IFC parameter span of a bounded curve used as an `IfcCompositeCurve`
/// `ParentCurve`: `N - 1` for an `IfcPolyline` of `N` points, the trimmed
/// length in `IfcVector` units for a trimmed `IfcLine`, and the swept angle in
/// the project's plane-angle unit for a trimmed `IfcCircle`. A composite
/// curve's parameter is the running sum of these spans, so this is the one
/// place both the analytic description and the swept-solid mesher read it
/// from (#5566). `None` means the parent's parametrisation is not supported.
pub(crate) fn composite_parent_parameter_span(
    parent: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<f64>> {
    let mut walk = curve::CurveWalk::default();
    let Some(pieces) = walk.extract(parent, decoder)? else {
        return Ok(None);
    };
    let Some(spans) = helpers::parent_piece_spans(parent, &pieces, decoder)? else {
        return Ok(None);
    };
    let span: f64 = spans.iter().sum();
    Ok(span.is_finite().then_some(span))
}
