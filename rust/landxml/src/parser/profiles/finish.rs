/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    capture::CrossSectionPointCapture,
    xml::{error, Result},
    LandXmlAlignment, LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode,
    LandXmlCrossSection, LandXmlCrossSectionPoint, LandXmlCrossSectionPointDataFormat,
    LandXmlCrossSectionSegment, LandXmlCrossSectionSurface, LandXmlGradeLine, LandXmlProfile,
    LandXmlProfilePoint, LandXmlSourceId, LandXmlVerticalCurve,
};

use super::super::{Code, PairListTarget, Parser, ProfileCurveCapture};
use super::values::{station_elevation, station_elevation_count, station_elevations};

impl Parser<'_> {
    pub(super) fn finish_profile_point(
        &mut self,
        text: &str,
        curve: Option<ProfileCurveCapture>,
    ) -> Result<()> {
        self.reserve_profile_points(1)?;
        let (station, elevation) = station_elevation(text, "profile point")?;
        let has_curve = curve.is_some();
        if has_curve && self.vertical_curves_seen >= self.limits.max_vertical_curves {
            return Err(error(Code::LimitExceeded, "vertical curve limit exceeded"));
        }
        let source_id = {
            let profile = self
                .profile
                .as_mut()
                .ok_or_else(|| error(Code::InvalidSemantic, "PVI outside profile"))?;
            let ordinal = profile.pvis.len() + 1;
            let source_id = LandXmlSourceId(format!("{}:pvi:{ordinal}", profile.source_id.0));
            profile.pvis.push(LandXmlProfilePoint {
                source_id: source_id.clone(),
                station,
                elevation,
            });
            if let Some(curve) = curve {
                let curve_ordinal = profile.vertical_curves.len() + 1;
                profile.vertical_curves.push(LandXmlVerticalCurve {
                    source_id: LandXmlSourceId(format!(
                        "{}:curve:{curve_ordinal}",
                        profile.source_id.0
                    )),
                    parent_profile_source_id: profile.source_id.clone(),
                    kind: curve.kind,
                    station,
                    elevation,
                    length: curve.length,
                    length_in: curve.length_in,
                    length_out: curve.length_out,
                    radius: curve.radius,
                });
            }
            source_id
        };
        if has_curve {
            self.vertical_curves_seen += 1;
        }
        if elevation.is_none() {
            self.missing_elevation(source_id)?;
        }
        Ok(())
    }

    pub(super) fn finish_pair_list(&mut self, text: &str, target: PairListTarget) -> Result<()> {
        let pair_count = station_elevation_count(text, "PntList2D")?;
        match target {
            PairListTarget::GradeLine => self.reserve_profile_points(pair_count)?,
            PairListTarget::CrossSectionSegment => self.reserve_cross_section_points(pair_count)?,
        }
        let pairs = station_elevations(text, "PntList2D")?;
        match target {
            PairListTarget::GradeLine => {
                let (ordinal, source_id, parent_source_id, discontinuous) = self
                    .profile
                    .as_ref()
                    .ok_or_else(|| error(Code::InvalidSemantic, "PntList2D outside profile"))
                    .map(|profile| {
                        let ordinal = profile.grade_lines.len() + 1;
                        (
                            ordinal,
                            LandXmlSourceId(format!(
                                "{}:grade-line:{ordinal}",
                                profile.source_id.0
                            )),
                            profile.source_id.clone(),
                            !profile.grade_lines.is_empty(),
                        )
                    })?;
                let points = self.profile_points(&pairs, &source_id)?;
                self.record_discontinuity(
                    discontinuous,
                    &source_id,
                    "ProfSurf contains multiple PntList2D segments; gap retained",
                )?;
                self.profile
                    .as_mut()
                    .expect("profile checked")
                    .grade_lines
                    .push(LandXmlGradeLine {
                        source_id,
                        parent_profile_source_id: parent_source_id,
                        ordinal,
                        points,
                    });
            }
            PairListTarget::CrossSectionSegment => {
                let (ordinal, source_id, parent_source_id, discontinuous) = self
                    .cross_section_surface
                    .as_ref()
                    .ok_or_else(|| error(Code::InvalidSemantic, "PntList2D outside CrossSectSurf"))
                    .map(|surface| {
                        let ordinal = surface.segments.len() + 1;
                        (
                            ordinal,
                            LandXmlSourceId(format!("{}:segment:{ordinal}", surface.source_id.0)),
                            surface.source_id.clone(),
                            !surface.segments.is_empty(),
                        )
                    })?;
                let points = self.cross_section_points(&pairs, &source_id)?;
                self.record_discontinuity(
                    discontinuous,
                    &source_id,
                    "CrossSectSurf contains multiple PntList2D segments; gap retained",
                )?;
                self.cross_section_surface
                    .as_mut()
                    .expect("surface checked")
                    .segments
                    .push(LandXmlCrossSectionSegment {
                        source_id,
                        parent_surface_source_id: parent_source_id,
                        ordinal,
                        points,
                    });
            }
        }
        Ok(())
    }

    pub(super) fn finish_cross_section_point(
        &mut self,
        text: &str,
        capture: CrossSectionPointCapture,
    ) -> Result<()> {
        let has_coordinates = !text.trim().is_empty();
        if !has_coordinates && capture.pnt_ref.is_none() {
            return Err(error(
                Code::InvalidSemantic,
                "CrossSectPnt requires coordinates or pntRef",
            ));
        }
        let (offset, elevation, slope, distance) = if has_coordinates {
            let (first, second) = station_elevation(text, "CrossSectPnt")?;
            match capture.data_format {
                LandXmlCrossSectionPointDataFormat::OffsetElevation => {
                    (Some(first), second, None, None)
                }
                LandXmlCrossSectionPointDataFormat::SlopeDistance => {
                    let distance = second.ok_or_else(|| {
                        error(
                            Code::InvalidSemantic,
                            "Slope Distance CrossSectPnt requires slope and distance",
                        )
                    })?;
                    (None, None, Some(first), Some(distance))
                }
            }
        } else {
            (None, None, None, None)
        };
        let surface = self.cross_section_surface.as_mut().ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                "CrossSectPnt outside DesignCrossSectSurf",
            )
        })?;
        let ordinal = surface.points.len() + 1;
        let source_id = LandXmlSourceId(format!("{}:point:{ordinal}", surface.source_id.0));
        surface.points.push(LandXmlCrossSectionPoint {
            source_id: source_id.clone(),
            data_format: capture.data_format,
            offset,
            elevation,
            slope,
            distance,
            pnt_ref: capture.pnt_ref.clone(),
            alignment_ref: capture.alignment_ref,
            align_ref_station: capture.align_ref_station,
            alignment_source_id: None,
            plan_feature_ref: capture.plan_feature_ref.clone(),
            plan_feature_ref_station: capture.plan_feature_ref_station,
            parcel_ref: capture.parcel_ref.clone(),
            parcel_ref_station: capture.parcel_ref_station,
        });
        if has_coordinates
            && capture.data_format == LandXmlCrossSectionPointDataFormat::OffsetElevation
            && elevation.is_none()
        {
            self.missing_elevation(source_id.clone())?;
        }
        if capture.data_format == LandXmlCrossSectionPointDataFormat::SlopeDistance {
            self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::UnsupportedSlopeDistance,
                source_id: Some(source_id.clone()),
                source_path: self.path(),
                message: "Slope Distance CrossSectPnt is retained without derived section geometry"
                    .to_owned(),
            })?;
        }
        if !has_coordinates {
            self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::UnresolvedPointReference,
                source_id: Some(source_id.clone()),
                source_path: self.path(),
                message:
                    "CrossSectPnt uses pntRef without coordinates; no point lookup is available"
                        .to_owned(),
            })?;
        }
        if capture.plan_feature_ref.is_some() {
            self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::UnsupportedPlanFeatureReference,
                source_id: Some(source_id.clone()),
                source_path: self.path(),
                message: "CrossSectPnt planFeatureRef is retained without plan-feature resolution"
                    .to_owned(),
            })?;
        }
        if capture.parcel_ref.is_some() {
            self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::UnsupportedParcelReference,
                source_id: Some(source_id),
                source_path: self.path(),
                message: "CrossSectPnt parcelRef is retained without parcel resolution".to_owned(),
            })?;
        }
        Ok(())
    }

    pub(super) fn finish_profile(&mut self) -> Result<()> {
        let value = self
            .profile
            .take()
            .ok_or_else(|| error(Code::InvalidSemantic, "profile closing without source"))?;
        self.profiles.push(LandXmlProfile {
            source_id: value.source_id,
            parent_alignment_source_id: value.parent_alignment_source_id,
            ordinal: value.ordinal,
            name: value.name,
            kind: value.kind,
            pvis: value.pvis,
            vertical_curves: value.vertical_curves,
            grade_lines: value.grade_lines,
        });
        Ok(())
    }

    pub(super) fn finish_cross_section_surface(&mut self) -> Result<()> {
        let value = self.cross_section_surface.take().ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                "cross-section surface closing without source",
            )
        })?;
        self.cross_section_surfaces
            .push(LandXmlCrossSectionSurface {
                source_id: value.source_id,
                parent_cross_section_source_id: value.parent_cross_section_source_id,
                kind: value.kind,
                name: value.name,
                segments: value.segments,
                points: value.points,
            });
        Ok(())
    }

    pub(super) fn finish_cross_section(&mut self) -> Result<()> {
        let value = self
            .cross_section
            .take()
            .ok_or_else(|| error(Code::InvalidSemantic, "CrossSect closing without source"))?;
        self.cross_sections.push(LandXmlCrossSection {
            source_id: value.source_id,
            parent_alignment_source_id: value.parent_alignment_source_id,
            ordinal: value.ordinal,
            station: value.station,
            surface_source_ids: value.surface_source_ids,
        });
        Ok(())
    }

    pub(super) fn finish_alignment(&mut self) -> Result<()> {
        let value = self
            .alignment
            .take()
            .ok_or_else(|| error(Code::InvalidSemantic, "Alignment closing without source"))?;
        self.alignments.push(LandXmlAlignment {
            source_id: value.source_id,
            ordinal: value.ordinal,
            name: value.name,
            length: value.length,
            sta_start: value.sta_start,
            profile_source_ids: value.profile_source_ids,
            cross_section_source_ids: value.cross_section_source_ids,
        });
        Ok(())
    }

    fn profile_points(
        &mut self,
        pairs: &[(f64, Option<f64>)],
        parent: &LandXmlSourceId,
    ) -> Result<Vec<LandXmlProfilePoint>> {
        let mut points = Vec::with_capacity(pairs.len());
        for (ordinal, (station, elevation)) in pairs.iter().copied().enumerate() {
            self.check_cancel_and_work(1)?;
            let source_id = LandXmlSourceId(format!("{}:point:{}", parent.0, ordinal + 1));
            points.push(LandXmlProfilePoint {
                source_id: source_id.clone(),
                station,
                elevation,
            });
            if elevation.is_none() {
                self.missing_elevation(source_id)?;
            }
        }
        Ok(points)
    }

    fn cross_section_points(
        &mut self,
        pairs: &[(f64, Option<f64>)],
        parent: &LandXmlSourceId,
    ) -> Result<Vec<LandXmlCrossSectionPoint>> {
        let mut points = Vec::with_capacity(pairs.len());
        for (ordinal, (offset, elevation)) in pairs.iter().copied().enumerate() {
            self.check_cancel_and_work(1)?;
            let source_id = LandXmlSourceId(format!("{}:point:{}", parent.0, ordinal + 1));
            points.push(LandXmlCrossSectionPoint {
                source_id: source_id.clone(),
                data_format: LandXmlCrossSectionPointDataFormat::OffsetElevation,
                offset: Some(offset),
                elevation,
                slope: None,
                distance: None,
                pnt_ref: None,
                alignment_ref: None,
                align_ref_station: None,
                alignment_source_id: None,
                plan_feature_ref: None,
                plan_feature_ref_station: None,
                parcel_ref: None,
                parcel_ref_station: None,
            });
            if elevation.is_none() {
                self.missing_elevation(source_id)?;
            }
        }
        Ok(points)
    }
}
