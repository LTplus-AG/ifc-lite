// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::{
    LandXmlAlignment, LandXmlCant, LandXmlCantStation, LandXmlPlanPoint, LandXmlPointLocation,
    LandXmlRadius, LandXmlRotation, LandXmlStationEquation, LandXmlSuperelevation,
    LandXmlSuperelevationEventKind,
};
use super::state::{
    invalid, limit, AlignmentBuilder, CantBuilder, SegmentBuilder, SuperelevationBuilder,
};
use super::{Capture, Parser};
use crate::{
    xml::{attr, required, Attributes, Result},
    LandXmlSourceId,
};

impl Parser<'_> {
    pub(super) fn begin_alignment(&mut self, attrs: &Attributes) -> Result<()> {
        if self.alignments.len() >= self.limits.max_alignments {
            return Err(invalid("alignment limit exceeded"));
        }
        if self.alignment.is_some() {
            return Err(invalid("nested Alignment is not valid"));
        }
        let ordinal = self.alignments.len() + 1;
        let name = required(attrs, "name", "Alignment")?.to_owned();
        let length = finite_attr(attrs, "length", "Alignment")?;
        let sta_start = finite_attr(attrs, "staStart", "Alignment")?;
        self.alignment = Some(AlignmentBuilder {
            alignment: LandXmlAlignment {
                source_id: LandXmlSourceId(format!("landxml:alignment:{ordinal}:{name}")),
                ordinal,
                name,
                length,
                sta_start,
                start: None,
                segments: Vec::new(),
                station_equations: Vec::new(),
                cant: None,
                superelevations: Vec::new(),
                unsupported_transitions: Vec::new(),
            },
            segment: None,
            cant: None,
            superelevation: None,
        });
        Ok(())
    }

    pub(super) fn begin_segment(&mut self, local: &str, attrs: &Attributes) -> Result<()> {
        if !matches!(local, "Line" | "IrregularLine" | "Curve" | "Spiral") {
            return Ok(());
        }
        if self.segments_seen >= self.limits.max_alignment_segments {
            return Err(limit("alignment segment limit exceeded"));
        }
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| invalid("CoordGeom outside Alignment"))?;
        if alignment.segment.is_some() {
            return Err(invalid("nested CoordGeom primitive is not valid"));
        }
        self.segments_seen += 1;
        alignment.segment = Some(match local {
            "Line" => SegmentBuilder::Line {
                start: None,
                end: None,
                length: optional_finite_attr(attrs, "length", "Line")?,
            },
            "IrregularLine" => SegmentBuilder::Irregular {
                start: None,
                end: None,
                points: Vec::new(),
                length: optional_finite_attr(attrs, "length", "IrregularLine")?,
            },
            "Curve" => SegmentBuilder::Curve {
                start: None,
                center: None,
                end: None,
                pi: None,
                rotation: rotation(required(attrs, "rot", "Curve")?)?,
                radius: optional_finite_attr(attrs, "radius", "Curve")?,
                length: optional_finite_attr(attrs, "length", "Curve")?,
            },
            "Spiral" => SegmentBuilder::Spiral {
                start: None,
                pi: None,
                end: None,
                spi_type: required(attrs, "spiType", "Spiral")?.to_owned(),
                radius_start: radius(required(attrs, "radiusStart", "Spiral")?)?,
                radius_end: radius(required(attrs, "radiusEnd", "Spiral")?)?,
                rotation: rotation(required(attrs, "rot", "Spiral")?)?,
                length: finite_attr(attrs, "length", "Spiral")?,
            },
            _ => unreachable!("primitive name checked above"),
        });
        Ok(())
    }

    pub(super) fn push_equation(&mut self, attrs: &Attributes) -> Result<()> {
        if self.station_equations_seen >= self.limits.max_station_equations {
            return Err(limit("station equation limit exceeded"));
        }
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| invalid("StaEquation outside Alignment"))?;
        self.station_equations_seen += 1;
        let ordinal = alignment.alignment.station_equations.len() + 1;
        let source_id = LandXmlSourceId(format!(
            "{}:station-equation:{ordinal}",
            alignment.alignment.source_id.0
        ));
        let sta_increment = attr(attrs, "staIncrement").map(str::to_owned);
        if sta_increment
            .as_deref()
            .is_some_and(|value| !matches!(value, "increasing" | "decreasing"))
        {
            return Err(invalid("StaEquation staIncrement is invalid"));
        }
        alignment
            .alignment
            .station_equations
            .push(LandXmlStationEquation {
                source_id,
                sta_internal: finite_attr(attrs, "staInternal", "StaEquation")?,
                sta_ahead: finite_attr(attrs, "staAhead", "StaEquation")?,
                sta_back: optional_finite_attr(attrs, "staBack", "StaEquation")?,
                sta_increment,
            });
        Ok(())
    }

    pub(super) fn begin_cant(&mut self, attrs: &Attributes) -> Result<()> {
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| invalid("Cant outside Alignment"))?;
        if alignment.cant.is_some() || alignment.alignment.cant.is_some() {
            return Err(invalid("Alignment may contain one Cant"));
        }
        alignment.cant = Some(CantBuilder {
            cant: LandXmlCant {
                source_id: LandXmlSourceId(format!("{}:cant", alignment.alignment.source_id.0)),
                name: required(attrs, "name", "Cant")?.to_owned(),
                gauge: finite_attr(attrs, "gauge", "Cant")?,
                rotation_point: attr(attrs, "rotationPoint").map(str::to_owned),
                stations: Vec::new(),
            },
        });
        Ok(())
    }

    pub(super) fn push_cant_station(&mut self, attrs: &Attributes) -> Result<()> {
        if self.cant_stations_seen >= self.limits.max_cant_stations {
            return Err(limit("CantStation limit exceeded"));
        }
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| invalid("CantStation outside Alignment"))?;
        let cant = alignment
            .cant
            .as_mut()
            .ok_or_else(|| invalid("CantStation outside Cant"))?;
        self.cant_stations_seen += 1;
        let ordinal = cant.cant.stations.len() + 1;
        let source_id = LandXmlSourceId(format!("{}:station:{ordinal}", cant.cant.source_id.0));
        cant.push_station(LandXmlCantStation {
            source_id,
            station: finite_attr(attrs, "station", "CantStation")?,
            applied_cant: finite_attr(attrs, "appliedCant", "CantStation")?,
            equilibrium_cant: optional_finite_attr(attrs, "equilibriumCant", "CantStation")?,
            curvature: rotation(required(attrs, "curvature", "CantStation")?)?,
        })
    }

    pub(super) fn begin_superelevation(&mut self, attrs: &Attributes) -> Result<()> {
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| invalid("Superelevation outside Alignment"))?;
        if alignment.superelevation.is_some() {
            return Err(invalid("nested Superelevation is not valid"));
        }
        let ordinal = alignment.alignment.superelevations.len() + 1;
        alignment.superelevation = Some(SuperelevationBuilder {
            superelevation: LandXmlSuperelevation {
                source_id: LandXmlSourceId(format!(
                    "{}:superelevation:{ordinal}",
                    alignment.alignment.source_id.0
                )),
                sta_start: optional_finite_attr(attrs, "staStart", "Superelevation")?,
                sta_end: optional_finite_attr(attrs, "staEnd", "Superelevation")?,
                events: Vec::new(),
            },
        });
        Ok(())
    }

    pub(super) fn finish_capture(&mut self) -> Result<()> {
        let capture = self
            .capture
            .take()
            .ok_or_else(|| invalid("missing capture"))?;
        match &capture {
            Capture::Point { pnt_ref: None, .. } => self.reserve_alignment_points(1)?,
            Capture::PointList {
                dimension, text, ..
            } => {
                let value_count = text.split_ascii_whitespace().count();
                if value_count < dimension * 2 || !value_count.is_multiple_of(*dimension) {
                    return Err(invalid("PntList has an invalid coordinate count"));
                }
                self.reserve_alignment_points(value_count / dimension)?;
            }
            Capture::Point {
                pnt_ref: Some(_), ..
            }
            | Capture::Superelevation { .. } => {}
        }
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| invalid("captured value outside Alignment"))?;
        match capture {
            Capture::Point {
                local,
                pnt_ref: Some(pnt_ref),
                text,
                ..
            } => {
                if !text.trim().is_empty() {
                    return Err(invalid("point must use coordinates or pntRef, not both"));
                }
                if local == "__alignment_start" {
                    alignment.alignment.start =
                        Some(LandXmlPointLocation::PointReference { pnt_ref });
                    return Ok(());
                }
                alignment
                    .segment
                    .as_mut()
                    .ok_or_else(|| invalid("point outside primitive"))?
                    .set_point(&local, LandXmlPointLocation::PointReference { pnt_ref })
            }
            Capture::Point {
                local,
                pnt_ref: None,
                text,
                ..
            } => {
                let point = plan_point(&text)?;
                if local == "__alignment_start" {
                    alignment.alignment.start = Some(LandXmlPointLocation::Coordinates { point });
                    return Ok(());
                }
                alignment
                    .segment
                    .as_mut()
                    .ok_or_else(|| invalid("point outside primitive"))?
                    .set_point(&local, LandXmlPointLocation::Coordinates { point })
            }
            Capture::PointList {
                dimension, text, ..
            } => {
                let points = point_list(&text, dimension)?;
                alignment
                    .segment
                    .as_mut()
                    .ok_or_else(|| invalid("PntList outside primitive"))?
                    .add_irregular_points(points)
            }
            Capture::Superelevation { kind, text, .. } => {
                let super_elevation = alignment
                    .superelevation
                    .as_mut()
                    .ok_or_else(|| invalid("superelevation event outside Superelevation"))?;
                if self.superelevation_events_seen >= self.limits.max_superelevation_events {
                    return Err(limit("superelevation event limit exceeded"));
                }
                self.superelevation_events_seen += 1;
                let value = text.trim();
                if value.is_empty() {
                    return Err(invalid("Superelevation event is empty"));
                }
                super_elevation.push_event(kind, value.to_owned());
                Ok(())
            }
        }
    }
}

pub(super) fn superelevation_event(local: &str) -> Option<LandXmlSuperelevationEventKind> {
    Some(match local {
        "BeginRunoutSta" => LandXmlSuperelevationEventKind::BeginRunoutSta,
        "BeginRunoffSta" => LandXmlSuperelevationEventKind::BeginRunoffSta,
        "FullSuperSta" => LandXmlSuperelevationEventKind::FullSuperSta,
        "FullSuperelev" => LandXmlSuperelevationEventKind::FullSuperelev,
        "RunoffSta" => LandXmlSuperelevationEventKind::RunoffSta,
        "StartofRunoutSta" => LandXmlSuperelevationEventKind::StartofRunoutSta,
        "EndofRunoutSta" => LandXmlSuperelevationEventKind::EndofRunoutSta,
        "AdverseSE" => LandXmlSuperelevationEventKind::AdverseSE,
        _ => return None,
    })
}

fn finite_attr(attrs: &Attributes, name: &str, context: &str) -> Result<f64> {
    finite(required(attrs, name, context)?, context)
}
fn optional_finite_attr(attrs: &Attributes, name: &str, context: &str) -> Result<Option<f64>> {
    attr(attrs, name)
        .map(|value| finite(value, context))
        .transpose()
}
fn finite(value: &str, context: &str) -> Result<f64> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| invalid(format!("{context} has invalid numeric value")))?;
    if parsed.is_finite() {
        Ok(parsed)
    } else {
        Err(invalid(format!(
            "{context} requires a finite numeric value"
        )))
    }
}
fn radius(value: &str) -> Result<LandXmlRadius> {
    if value == "INF" {
        return Ok(LandXmlRadius::Infinite);
    }
    let value = finite(value, "Spiral radius")?;
    if value > 0.0 {
        Ok(LandXmlRadius::Finite(value))
    } else {
        Err(invalid("Spiral radius must be positive or INF"))
    }
}
fn rotation(value: &str) -> Result<LandXmlRotation> {
    match value {
        "cw" => Ok(LandXmlRotation::Clockwise),
        "ccw" => Ok(LandXmlRotation::CounterClockwise),
        _ => Err(invalid("rotation must be cw or ccw")),
    }
}
fn plan_point(text: &str) -> Result<LandXmlPlanPoint> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "coordinate"))
        .collect::<Result<_>>()?;
    let elevation = match values.as_slice() {
        [northing, easting] => {
            return Ok(LandXmlPlanPoint {
                northing: *northing,
                easting: *easting,
                elevation: None,
            })
        }
        [northing, easting, elevation] => Some((*northing, *easting, *elevation)),
        _ => None,
    };
    elevation.map_or_else(
        || Err(invalid("coordinate requires northing easting [elevation]")),
        |(northing, easting, elevation)| {
            Ok(LandXmlPlanPoint {
                northing,
                easting,
                elevation: Some(elevation),
            })
        },
    )
}
fn point_list(text: &str, dimension: usize) -> Result<Vec<LandXmlPlanPoint>> {
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|value| finite(value, "PntList coordinate"))
        .collect::<Result<_>>()?;
    if values.len() < dimension * 2 || !values.len().is_multiple_of(dimension) {
        return Err(invalid("PntList has an invalid coordinate count"));
    }
    Ok(values
        .chunks_exact(dimension)
        .map(|value| LandXmlPlanPoint {
            northing: value[0],
            easting: value[1],
            elevation: if dimension == 3 { Some(value[2]) } else { None },
        })
        .collect())
}
