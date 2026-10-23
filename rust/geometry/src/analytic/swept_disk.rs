// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSweptDiskSolid` directrix interpretation, and opt-in authored source.

use super::{curve, helpers, owned_directrix, AnalyticBoundarySource, AnalyticCurveSegment,
    AnalyticStatus, AnalyticSweptDisk, OwnedDirectrix};
use crate::{Error, Result};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use slot::IfcSweptDiskSolid as Disk;

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
        .get_ref(Disk::DIRECTRIX.index())
        .ok_or_else(|| Error::geometry("IfcSweptDiskSolid missing Directrix".to_string()))?;
    let radius = read_optional_numeric(entity.get(Disk::RADIUS.index()), "Radius")?
        .filter(|r| r.is_finite() && *r > 0.0)
        .ok_or_else(|| Error::geometry("IfcSweptDiskSolid has invalid Radius".to_string()))?;
    let inner_radius =
        read_optional_numeric(entity.get(Disk::INNER_RADIUS.index()), "InnerRadius")?;
    if inner_radius.is_some_and(|r| !r.is_finite() || r <= 0.0 || r >= radius) {
        return Err(Error::geometry(
            "IfcSweptDiskSolid has invalid InnerRadius".to_string(),
        ));
    }
    let directrix = decoder
        .resolve_ref(&AttributeValue::EntityRef(directrix_id))?
        .ok_or_else(|| {
            Error::geometry("IfcSweptDiskSolid Directrix cannot be resolved".to_string())
        })?;
    let capture = super::source::requested();
    let mut walk =
        if capture { curve::CurveWalk::with_source() } else { curve::CurveWalk::default() };
    if capture {
        walk.source.record(entity, decoder);
    }
    let start = read_optional_numeric(entity.get(Disk::START_PARAM.index()), "StartParam")?;
    let end = read_optional_numeric(entity.get(Disk::END_PARAM.index()), "EndParam")?;
    let (effective_start, effective_end) = crate::swept_disk_range::effective_range(
        directrix.ifc_type.clone(), start, end, decoder,
    );
    let has_trim = effective_start.is_some() || effective_end.is_some();
    let extracted = if directrix.ifc_type == IfcType::IfcLine && (start.is_none() || end.is_none())
    {
        if capture {
            walk.source.record(&directrix, decoder);
        }
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
        trim_segments(&directrix, &mut segments, &mut status, effective_start, effective_end, decoder)?;
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
    let (source, owned_directrix) = if capture {
        let source = walk.source.finish(entity.id, decoder.plane_angle_to_radians());
        let owned = rational_directrix(&source, &directrix, start, end)
            .or_else(|| matches!(status, AnalyticStatus::Complete)
                .then(|| OwnedDirectrix::Segments(segments.clone())));
        (Some(source), owned)
    } else {
        (None, None)
    };
    Ok(AnalyticSweptDisk {
        directrix_id,
        start_param: start,
        end_param: end,
        source,
        owned_directrix,
        radius,
        inner_radius,
        segments,
        status,
    })
}

/// Apply solid-level StartParam/EndParam to the interpreted line/arc segments.
fn trim_segments(
    directrix: &DecodedEntity,
    segments: &mut Vec<AnalyticCurveSegment>,
    status: &mut AnalyticStatus,
    start: Option<f64>,
    end: Option<f64>,
    decoder: &mut EntityDecoder,
) -> Result<()> {
    match directrix.ifc_type {
        IfcType::IfcPolyline => {
            *segments = helpers::trim_indexed_segments(segments, start, end)?;
        }
        IfcType::IfcCompositeCurve | IfcType::IfcCompositeCurveOnSurface => {}
        IfcType::IfcTrimmedCurve => {
            if !trimmed_line_solid_bounds_redundant(directrix, segments, start, end, decoder)?
            {
                *status = AnalyticStatus::Unsupported(
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
                *status = AnalyticStatus::Unsupported(
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
            *segments = vec![line.subsegment(start.unwrap_or(0.0), end.unwrap_or(1.0))];
        }
        _ => {
            *status = AnalyticStatus::Unsupported(
                "solid-level trim for this directrix is unsupported".to_string(),
            )
        }
    }
    Ok(())
}

/// A rational B-spline directrix, read from the captured original records and
/// restricted to the solid-level bounds in its own basis parameter. `None` when
/// the directrix is not a single rational curve or its bounds are ambiguous.
fn rational_directrix(
    source: &AnalyticBoundarySource,
    directrix: &DecodedEntity,
    start: Option<f64>,
    end: Option<f64>,
) -> Option<OwnedDirectrix> {
    let mut curve = owned_directrix::rational_from_root(source, directrix.id).ok()?;
    // Solid bounds on a trimmed curve address the trimmed domain, not the
    // basis parameter; refuse rather than reinterpret them.
    if directrix.ifc_type == IfcType::IfcTrimmedCurve && (start.is_some() || end.is_some()) {
        return None;
    }
    curve.restrict_range(start, end).ok()?;
    Some(OwnedDirectrix::Rational(curve))
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
    let Some(basis_attr) = directrix.get(slot::IfcTrimmedCurve::BASIS_CURVE.index()) else {
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

/// STEP typed numeric wrappers are decoded by `AttributeValue::as_float` in
/// `ifc-lite-core`. Distinguish an omitted optional value from a present value
/// with malformed contents, which must not silently widen a directrix.
fn read_optional_numeric(value: Option<&AttributeValue>, field: &str) -> Result<Option<f64>> {
    match value {
        None | Some(AttributeValue::Null | AttributeValue::Derived) => Ok(None),
        Some(value) => value
            .as_float()
            .map(Some)
            .ok_or_else(|| Error::geometry(format!("IfcSweptDiskSolid has invalid {field}"))),
    }
}
