/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    capture::CrossSectionPointCapture,
    xml::{attr, error, required, Attributes, Result},
    LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode,
    LandXmlCrossSectionPointDataFormat, LandXmlCrossSectionSurfaceKind, LandXmlProfileKind,
    LandXmlRoadway, LandXmlSourceId, LandXmlVerticalCurveKind,
};

use super::super::{Capture, Code, PairListTarget, Parser, ProfileCurveCapture};
use super::values::{finite_attr, optional_finite_attr, references_attr};
use super::{AlignmentBuilder, CrossSectionBuilder, CrossSectionSurfaceBuilder, ProfileBuilder};

impl Parser<'_> {
    pub(super) fn start_alignment(&mut self, attributes: &Attributes) -> Result<()> {
        if self.alignments.len() >= self.limits.max_alignments {
            return Err(error(Code::LimitExceeded, "alignment limit exceeded"));
        }
        let ordinal = self.alignments.len() + 1;
        let name = required(attributes, "name", "Alignment")?.to_owned();
        self.alignment = Some(AlignmentBuilder {
            source_id: LandXmlSourceId(format!("landxml:alignment:{ordinal}:{name}")),
            ordinal,
            length: finite_attr(attributes, "length", "Alignment")?,
            sta_start: finite_attr(attributes, "staStart", "Alignment")?,
            name,
            profile_source_ids: Vec::new(),
            cross_section_source_ids: Vec::new(),
        });
        Ok(())
    }

    pub(super) fn start_profile(
        &mut self,
        attributes: &Attributes,
        kind: LandXmlProfileKind,
    ) -> Result<()> {
        if self.profiles.len() >= self.limits.max_profiles {
            return Err(error(Code::LimitExceeded, "profile limit exceeded"));
        }
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| error(Code::InvalidSemantic, "profile outside Alignment"))?;
        let ordinal = alignment.profile_source_ids.len() + 1;
        let name = required(attributes, "name", "profile")?.to_owned();
        let kind_name = match kind {
            LandXmlProfileKind::Design => "design",
            LandXmlProfileKind::Sampled => "sampled",
        };
        let source_id = LandXmlSourceId(format!(
            "landxml:profile:{}:{ordinal}:{kind_name}:{name}",
            alignment.ordinal
        ));
        alignment.profile_source_ids.push(source_id.clone());
        self.profile = Some(ProfileBuilder {
            source_id,
            parent_alignment_source_id: alignment.source_id.clone(),
            ordinal,
            name,
            kind,
            pvis: Vec::new(),
            vertical_curves: Vec::new(),
            grade_lines: Vec::new(),
        });
        Ok(())
    }

    pub(super) fn start_profile_point(
        &mut self,
        local: &str,
        attributes: &Attributes,
    ) -> Result<()> {
        let curve = match local {
            "PVI" => None,
            "ParaCurve" => Some(ProfileCurveCapture {
                kind: LandXmlVerticalCurveKind::Parabolic,
                length: Some(finite_attr(attributes, "length", "ParaCurve")?),
                length_in: None,
                length_out: None,
                radius: None,
            }),
            "UnsymParaCurve" => Some(ProfileCurveCapture {
                kind: LandXmlVerticalCurveKind::UnsymmetricalParabolic,
                length: None,
                length_in: Some(finite_attr(attributes, "lengthIn", "UnsymParaCurve")?),
                length_out: Some(finite_attr(attributes, "lengthOut", "UnsymParaCurve")?),
                radius: None,
            }),
            "CircCurve" => Some(ProfileCurveCapture {
                kind: LandXmlVerticalCurveKind::Circular,
                length: Some(finite_attr(attributes, "length", "CircCurve")?),
                length_in: None,
                length_out: None,
                radius: Some(finite_attr(attributes, "radius", "CircCurve")?),
            }),
            _ => return Ok(()),
        };
        self.capture = Some(Capture::ProfilePoint {
            depth: self.frames.len(),
            text: String::new(),
            curve,
        });
        Ok(())
    }

    pub(super) fn start_pair_list(&mut self, target: PairListTarget) -> Result<()> {
        self.capture = Some(Capture::PairList {
            depth: self.frames.len(),
            text: String::new(),
            target,
        });
        Ok(())
    }

    pub(super) fn start_cross_section(&mut self, attributes: &Attributes) -> Result<()> {
        if self.cross_sections.len() >= self.limits.max_cross_sections {
            return Err(error(Code::LimitExceeded, "cross-section limit exceeded"));
        }
        let alignment = self
            .alignment
            .as_mut()
            .ok_or_else(|| error(Code::InvalidSemantic, "CrossSect outside Alignment"))?;
        let ordinal = alignment.cross_section_source_ids.len() + 1;
        let station = finite_attr(attributes, "sta", "CrossSect")?;
        let source_id = LandXmlSourceId(format!(
            "landxml:cross-section:{}:{ordinal}:{station}",
            alignment.ordinal
        ));
        alignment.cross_section_source_ids.push(source_id.clone());
        self.cross_section = Some(CrossSectionBuilder {
            source_id,
            parent_alignment_source_id: alignment.source_id.clone(),
            ordinal,
            station,
            surface_source_ids: Vec::new(),
        });
        Ok(())
    }

    pub(super) fn start_cross_section_surface(
        &mut self,
        attributes: &Attributes,
        kind: LandXmlCrossSectionSurfaceKind,
    ) -> Result<()> {
        if self.cross_section_surfaces.len() >= self.limits.max_cross_section_surfaces {
            return Err(error(
                Code::LimitExceeded,
                "cross-section surface limit exceeded",
            ));
        }
        let cross_section = self.cross_section.as_mut().ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                "cross-section surface outside CrossSect",
            )
        })?;
        let ordinal = cross_section.surface_source_ids.len() + 1;
        let name = attr(attributes, "name").map(str::to_owned);
        if kind == LandXmlCrossSectionSurfaceKind::Sampled && name.is_none() {
            return Err(error(
                Code::InvalidSemantic,
                "CrossSectSurf is missing name",
            ));
        }
        let source_id = LandXmlSourceId(format!("{}:surface:{ordinal}", cross_section.source_id.0));
        cross_section.surface_source_ids.push(source_id.clone());
        self.cross_section_surface = Some(CrossSectionSurfaceBuilder {
            source_id,
            parent_cross_section_source_id: cross_section.source_id.clone(),
            kind,
            name,
            segments: Vec::new(),
            points: Vec::new(),
        });
        Ok(())
    }

    pub(super) fn start_cross_section_point(&mut self, attributes: &Attributes) -> Result<()> {
        self.reserve_cross_section_points(1)?;
        let data_format = match attr(attributes, "dataFormat").unwrap_or("Offset Elevation") {
            "Offset Elevation" => LandXmlCrossSectionPointDataFormat::OffsetElevation,
            "Slope Distance" => LandXmlCrossSectionPointDataFormat::SlopeDistance,
            _ => {
                return Err(error(
                    Code::InvalidSemantic,
                    "CrossSectPnt has unsupported dataFormat",
                ));
            }
        };
        self.capture = Some(Capture::CrossSectionPoint {
            depth: self.frames.len(),
            text: String::new(),
            point: CrossSectionPointCapture {
                data_format,
                pnt_ref: attr(attributes, "pntRef").map(str::to_owned),
                alignment_ref: attr(attributes, "alignRef").map(str::to_owned),
                align_ref_station: optional_finite_attr(
                    attributes,
                    "alignRefStation",
                    "CrossSectPnt",
                )?,
                plan_feature_ref: attr(attributes, "planFeatureRef").map(str::to_owned),
                plan_feature_ref_station: optional_finite_attr(
                    attributes,
                    "planFeatureRefStation",
                    "CrossSectPnt",
                )?,
                parcel_ref: attr(attributes, "parcelRef").map(str::to_owned),
                parcel_ref_station: optional_finite_attr(
                    attributes,
                    "parcelRefStation",
                    "CrossSectPnt",
                )?,
            },
        });
        Ok(())
    }

    pub(super) fn start_roadway(&mut self, attributes: &Attributes) -> Result<()> {
        if self.roadways.len() >= self.limits.max_roadways {
            return Err(error(Code::LimitExceeded, "roadway limit exceeded"));
        }
        let ordinal = self.roadways.len() + 1;
        let name = required(attributes, "name", "Roadway")?.to_owned();
        let alignment_refs = references_attr(attributes, "alignmentRefs");
        let source_id = LandXmlSourceId(format!("landxml:roadway:{ordinal}:{name}"));
        if alignment_refs.is_empty() {
            self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::MissingReference,
                source_id: Some(source_id.clone()),
                source_path: "LandXML/Roadways/Roadway/@alignmentRefs".to_owned(),
                message: "Roadway has no alignmentRefs association".to_owned(),
            })?;
        }
        self.active_roadway_source_id = Some(source_id.clone());
        self.roadways.push(LandXmlRoadway {
            source_id,
            ordinal,
            name,
            alignment_refs,
            alignment_source_ids: Vec::new(),
            surface_refs: references_attr(attributes, "surfaceRefs"),
            surface_source_ids: Vec::new(),
            grade_model_refs: references_attr(attributes, "gradeModelRefs"),
        });
        Ok(())
    }
}
