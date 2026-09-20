/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    xml::{error, Result},
    LandXmlAlignment, LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode,
    LandXmlCrossSection, LandXmlCrossSectionPoint, LandXmlCrossSectionSegment,
    LandXmlCrossSectionSurface, LandXmlGradeLine, LandXmlProfile, LandXmlProfilePoint,
    LandXmlSourceId, LandXmlVerticalCurve,
};

use super::super::{Code, PairListTarget, Parser, ProfileCurveCapture};
use super::values::{station_elevation, station_elevations};

impl Parser<'_> {
    pub(super) fn finish_profile_point(
        &mut self,
        text: &str,
        curve: Option<ProfileCurveCapture>,
    ) -> Result<()> {
        if self.profile_points_seen >= self.limits.max_profile_points {
            return Err(error(Code::LimitExceeded, "profile point limit exceeded"));
        }
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
        self.profile_points_seen += 1;
        if has_curve {
            self.vertical_curves_seen += 1;
        }
        if elevation.is_none() {
            self.missing_elevation(source_id);
        }
        Ok(())
    }

    pub(super) fn finish_pair_list(&mut self, text: &str, target: PairListTarget) -> Result<()> {
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
                );
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
                );
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
        alignment_ref: Option<String>,
    ) -> Result<()> {
        if self.cross_section_points_seen >= self.limits.max_cross_section_points {
            return Err(error(
                Code::LimitExceeded,
                "cross-section point limit exceeded",
            ));
        }
        let (offset, elevation) = station_elevation(text, "CrossSectPnt")?;
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
            offset,
            elevation,
            alignment_ref,
            alignment_source_id: None,
        });
        self.cross_section_points_seen += 1;
        if elevation.is_none() {
            self.missing_elevation(source_id);
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
            station_start: value.station_start,
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
            if self.profile_points_seen >= self.limits.max_profile_points {
                return Err(error(Code::LimitExceeded, "profile point limit exceeded"));
            }
            let source_id = LandXmlSourceId(format!("{}:point:{}", parent.0, ordinal + 1));
            points.push(LandXmlProfilePoint {
                source_id: source_id.clone(),
                station,
                elevation,
            });
            self.profile_points_seen += 1;
            if elevation.is_none() {
                self.missing_elevation(source_id);
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
            if self.cross_section_points_seen >= self.limits.max_cross_section_points {
                return Err(error(
                    Code::LimitExceeded,
                    "cross-section point limit exceeded",
                ));
            }
            let source_id = LandXmlSourceId(format!("{}:point:{}", parent.0, ordinal + 1));
            points.push(LandXmlCrossSectionPoint {
                source_id: source_id.clone(),
                offset,
                elevation,
                alignment_ref: None,
                alignment_source_id: None,
            });
            self.cross_section_points_seen += 1;
            if elevation.is_none() {
                self.missing_elevation(source_id);
            }
        }
        Ok(points)
    }

    fn record_discontinuity(
        &mut self,
        discontinuous: bool,
        source_id: &LandXmlSourceId,
        message: &str,
    ) {
        if discontinuous {
            self.capability_diagnostics
                .push(LandXmlCapabilityDiagnostic {
                    code: LandXmlCapabilityDiagnosticCode::SectionDiscontinuity,
                    source_id: Some(source_id.clone()),
                    source_path: self.path(),
                    message: message.to_owned(),
                });
        }
    }

    fn missing_elevation(&mut self, source_id: LandXmlSourceId) {
        self.capability_diagnostics
            .push(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::MissingElevation,
                source_id: Some(source_id),
                source_path: self.path(),
                message: "source point has no elevation; no derived geometry is available"
                    .to_owned(),
            });
    }
}
