// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::{
    LandXmlAlignment, LandXmlAlignmentPi, LandXmlAlignmentPrimitive, LandXmlAlignmentSegment,
    LandXmlCant, LandXmlCantStation, LandXmlCurve, LandXmlIrregularLine, LandXmlLine,
    LandXmlPlanPoint, LandXmlPointLocation, LandXmlRadius, LandXmlRotation, LandXmlSpiral,
    LandXmlSuperelevation, LandXmlSuperelevationEvent, LandXmlSuperelevationEventKind,
    LandXmlUnsupportedTransition,
};
use crate::{xml::Result, LandXmlDiagnosticCode as Code, LandXmlError, LandXmlSourceId};

pub(in crate::alignment) struct AlignmentBuilder {
    pub(super) alignment: LandXmlAlignment,
    pub(super) segment: Option<SegmentBuilder>,
    pub(super) cant: Option<CantBuilder>,
    pub(super) superelevation: Option<SuperelevationBuilder>,
}

pub(super) enum SegmentBuilder {
    Line {
        start: Option<LandXmlPointLocation>,
        end: Option<LandXmlPointLocation>,
        length: Option<f64>,
    },
    Irregular {
        start: Option<LandXmlPointLocation>,
        end: Option<LandXmlPointLocation>,
        points: Vec<LandXmlPlanPoint>,
        length: Option<f64>,
    },
    Curve {
        start: Option<LandXmlPointLocation>,
        center: Option<LandXmlPointLocation>,
        end: Option<LandXmlPointLocation>,
        pi: Option<LandXmlPointLocation>,
        rotation: LandXmlRotation,
        radius: Option<f64>,
        length: Option<f64>,
    },
    Spiral {
        start: Option<LandXmlPointLocation>,
        pi: Option<LandXmlPointLocation>,
        end: Option<LandXmlPointLocation>,
        spi_type: String,
        radius_start: LandXmlRadius,
        radius_end: LandXmlRadius,
        rotation: LandXmlRotation,
        length: f64,
    },
}

pub(super) struct CantBuilder {
    pub(super) cant: LandXmlCant,
}

pub(super) struct SuperelevationBuilder {
    pub(super) superelevation: LandXmlSuperelevation,
}

impl AlignmentBuilder {
    pub(super) fn push_align_pi(&mut self, location: LandXmlPointLocation) -> Result<()> {
        let ordinal = self.alignment.align_pis.len() + 1;
        self.alignment.align_pis.push(LandXmlAlignmentPi {
            source_id: LandXmlSourceId(format!(
                "{}:align-pi:{ordinal}",
                self.alignment.source_id.0
            )),
            location,
        });
        Ok(())
    }

    pub(super) fn push_segment(&mut self) -> Result<()> {
        let ordinal = self.alignment.segments.len() + 1;
        let source_id =
            LandXmlSourceId(format!("{}:segment:{ordinal}", self.alignment.source_id.0));
        let primitive = match self
            .segment
            .take()
            .ok_or_else(|| invalid("missing alignment segment"))?
        {
            SegmentBuilder::Line { start, end, length } => {
                LandXmlAlignmentPrimitive::Line(LandXmlLine {
                    start: required_point(start, "Line Start")?,
                    end: required_point(end, "Line End")?,
                    declared_length: length,
                })
            }
            SegmentBuilder::Irregular {
                start,
                end,
                points,
                length,
            } => LandXmlAlignmentPrimitive::IrregularLine(LandXmlIrregularLine {
                start: required_point(start, "IrregularLine Start")?,
                end: required_point(end, "IrregularLine End")?,
                points,
                declared_length: length,
            }),
            SegmentBuilder::Curve {
                start,
                center,
                end,
                pi,
                rotation,
                radius,
                length,
            } => LandXmlAlignmentPrimitive::Curve(LandXmlCurve {
                start: required_point(start, "Curve Start")?,
                center: required_point(center, "Curve Center")?,
                end: required_point(end, "Curve End")?,
                pi,
                rotation,
                radius,
                declared_length: length,
            }),
            SegmentBuilder::Spiral {
                start,
                pi,
                end,
                spi_type,
                radius_start,
                radius_end,
                rotation,
                length,
            } => {
                let spiral = LandXmlSpiral {
                    start: required_point(start, "Spiral Start")?,
                    pi: required_point(pi, "Spiral PI")?,
                    end: required_point(end, "Spiral End")?,
                    spi_type: spi_type.clone(),
                    radius_start,
                    radius_end,
                    rotation,
                    declared_length: length,
                };
                if spi_type != "clothoid" {
                    self.alignment.unsupported_transitions.push(LandXmlUnsupportedTransition { source_id: source_id.clone(), spi_type, spiral: spiral.clone(), reason: "LandXML transition type is retained but this numeric foundation supports clothoid only".to_owned() });
                    let retained = self
                        .alignment
                        .unsupported_transitions
                        .last()
                        .expect("just pushed");
                    LandXmlAlignmentPrimitive::UnsupportedSpiral(retained.spiral.clone())
                } else {
                    LandXmlAlignmentPrimitive::Spiral(spiral)
                }
            }
        };
        self.alignment.segments.push(LandXmlAlignmentSegment {
            source_id,
            ordinal,
            primitive,
        });
        Ok(())
    }

    pub(super) fn push_cant(&mut self) -> Result<()> {
        let cant = self
            .cant
            .take()
            .ok_or_else(|| invalid("missing Cant"))?
            .cant;
        if cant.stations.is_empty() && cant.speed_stations.is_empty() {
            return Err(invalid("Cant requires a CantStation or SpeedStation"));
        }
        if self.alignment.cant.replace(cant).is_some() {
            return Err(invalid("Alignment may contain at most one Cant"));
        }
        Ok(())
    }

    pub(super) fn push_superelevation(&mut self) -> Result<()> {
        let value = self
            .superelevation
            .take()
            .ok_or_else(|| invalid("missing Superelevation"))?
            .superelevation;
        if value.events.is_empty() {
            return Err(invalid("Superelevation requires at least one named event"));
        }
        self.alignment.superelevations.push(value);
        Ok(())
    }
}

impl SegmentBuilder {
    pub(super) fn set_point(&mut self, name: &str, point: LandXmlPointLocation) -> Result<()> {
        let target = match self {
            Self::Line { start, end, .. } | Self::Irregular { start, end, .. } => match name {
                "Start" => start,
                "End" => end,
                _ => return Err(invalid("unexpected coordinate leaf")),
            },
            Self::Curve {
                start,
                center,
                end,
                pi,
                ..
            } => match name {
                "Start" => start,
                "Center" => center,
                "End" => end,
                "PI" => pi,
                _ => return Err(invalid("unexpected curve coordinate leaf")),
            },
            Self::Spiral { start, pi, end, .. } => match name {
                "Start" => start,
                "PI" => pi,
                "End" => end,
                _ => return Err(invalid("unexpected spiral coordinate leaf")),
            },
        };
        if target.replace(point).is_some() {
            return Err(invalid("duplicate primitive coordinate leaf"));
        }
        Ok(())
    }

    pub(super) fn add_irregular_points(&mut self, points: Vec<LandXmlPlanPoint>) -> Result<()> {
        match self {
            Self::Irregular { points: target, .. } => {
                *target = points;
                Ok(())
            }
            _ => Err(invalid(
                "PntList is valid only for IrregularLine in an Alignment",
            )),
        }
    }
}

impl CantBuilder {
    pub(super) fn push_station(&mut self, station: LandXmlCantStation) -> Result<()> {
        if self
            .cant
            .stations
            .last()
            .is_some_and(|previous| station.station <= previous.station)
        {
            return Err(invalid("CantStation values must be strictly increasing"));
        }
        self.cant.stations.push(station);
        Ok(())
    }
}

impl SuperelevationBuilder {
    pub(super) fn push_event(
        &mut self,
        kind: LandXmlSuperelevationEventKind,
        value: Option<String>,
    ) {
        let ordinal = self.superelevation.events.len() + 1;
        self.superelevation.events.push(LandXmlSuperelevationEvent {
            source_id: LandXmlSourceId(format!(
                "{}:event:{ordinal}",
                self.superelevation.source_id.0
            )),
            kind,
            value,
        });
    }
}

pub(super) fn invalid(message: impl Into<String>) -> LandXmlError {
    LandXmlError::new(Code::InvalidSemantic, message)
}
pub(super) fn limit(message: impl Into<String>) -> LandXmlError {
    LandXmlError::new(Code::LimitExceeded, message)
}

fn required_point(point: Option<LandXmlPointLocation>, name: &str) -> Result<LandXmlPointLocation> {
    point.ok_or_else(|| invalid(format!("{name} is required")))
}
