/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;

use crate::{
    xml::{error, Attributes, Result},
    LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode, LandXmlCrossSectionSurfaceKind,
    LandXmlPreservedOnlyExtension, LandXmlPreservedOnlyExtensionKind, LandXmlProfileKind,
    LandXmlSourceId,
};

use super::super::{Capture, Code, PairListTarget, Parser};

impl Parser<'_> {
    pub(in super::super) fn start_road_semantics(
        &mut self,
        local: &str,
        attributes: &Attributes,
    ) -> Result<()> {
        match local {
            "Alignment" if self.is_path(&["LandXML", "Alignments", "Alignment"]) => {
                self.start_alignment(attributes)
            }
            "ProfAlign"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "Profile",
                    "ProfAlign",
                ]) =>
            {
                self.start_profile(attributes, LandXmlProfileKind::Design)
            }
            "ProfSurf"
                if self.is_path(&["LandXML", "Alignments", "Alignment", "Profile", "ProfSurf"]) =>
            {
                self.start_profile(attributes, LandXmlProfileKind::Sampled)
            }
            "PVI" | "ParaCurve" | "UnsymParaCurve" | "CircCurve"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "Profile",
                    "ProfAlign",
                    local,
                ]) =>
            {
                self.start_profile_point(local, attributes)
            }
            "PntList2D"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "Profile",
                    "ProfSurf",
                    "PntList2D",
                ]) =>
            {
                self.start_pair_list(PairListTarget::GradeLine)
            }
            "CrossSect"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "CrossSects",
                    "CrossSect",
                ]) =>
            {
                self.start_cross_section(attributes)
            }
            "CrossSectSurf"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "CrossSects",
                    "CrossSect",
                    "CrossSectSurf",
                ]) =>
            {
                self.start_cross_section_surface(
                    attributes,
                    LandXmlCrossSectionSurfaceKind::Sampled,
                )
            }
            "DesignCrossSectSurf"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "CrossSects",
                    "CrossSect",
                    "DesignCrossSectSurf",
                ]) =>
            {
                self.start_cross_section_surface(attributes, LandXmlCrossSectionSurfaceKind::Design)
            }
            "PntList2D"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "CrossSects",
                    "CrossSect",
                    "CrossSectSurf",
                    "PntList2D",
                ]) =>
            {
                self.start_pair_list(PairListTarget::CrossSectionSegment)
            }
            "CrossSectPnt"
                if self.is_path(&[
                    "LandXML",
                    "Alignments",
                    "Alignment",
                    "CrossSects",
                    "CrossSect",
                    "DesignCrossSectSurf",
                    "CrossSectPnt",
                ]) =>
            {
                self.start_cross_section_point(attributes)
            }
            "Roadway" if self.is_path(&["LandXML", "Roadways", "Roadway"]) => {
                self.start_roadway(attributes)
            }
            "Corridor" => {
                self.record_preserved_only(local, LandXmlPreservedOnlyExtensionKind::Corridor)
            }
            "StringLine" => {
                self.record_preserved_only(local, LandXmlPreservedOnlyExtensionKind::StringLine)
            }
            _ => Ok(()),
        }
    }

    pub(in super::super) fn finish_road_semantics(&mut self) -> Result<()> {
        let alignment_ids: HashMap<String, LandXmlSourceId> = self
            .alignments
            .iter()
            .map(|value| (value.name.clone(), value.source_id.clone()))
            .collect();
        let surface_ids: HashMap<String, LandXmlSourceId> = self
            .surfaces
            .iter()
            .map(|value| (value.name.clone(), value.source_id.clone()))
            .collect();
        let mut diagnostics = Vec::new();
        for roadway in &mut self.roadways {
            for reference in &roadway.alignment_refs {
                if let Some(source_id) = alignment_ids.get(reference) {
                    roadway.alignment_source_ids.push(source_id.clone());
                } else {
                    diagnostics.push(missing_reference(
                        &roadway.source_id,
                        "LandXML/Roadways/Roadway/@alignmentRefs",
                        "Roadway",
                        "Alignment",
                        reference,
                    ));
                }
            }
            for reference in &roadway.surface_refs {
                if let Some(source_id) = surface_ids.get(reference) {
                    roadway.surface_source_ids.push(source_id.clone());
                } else {
                    diagnostics.push(missing_reference(
                        &roadway.source_id,
                        "LandXML/Roadways/Roadway/@surfaceRefs",
                        "Roadway",
                        "Surface",
                        reference,
                    ));
                }
            }
        }
        for surface in &mut self.cross_section_surfaces {
            for point in &mut surface.points {
                if let Some(reference) = &point.alignment_ref {
                    if let Some(source_id) = alignment_ids.get(reference) {
                        point.alignment_source_id = Some(source_id.clone());
                    } else {
                        diagnostics.push(missing_reference(&point.source_id, "LandXML/Alignments/Alignment/CrossSects/CrossSect/DesignCrossSectSurf/CrossSectPnt/@alignRef", "CrossSectPnt", "Alignment", reference));
                    }
                }
            }
        }
        for diagnostic in diagnostics {
            self.record_capability_diagnostic(diagnostic)?;
        }
        Ok(())
    }

    pub(in super::super) fn finish_road_element(&mut self) -> Result<()> {
        if self.is_path(&["LandXML", "Alignments", "Alignment", "Profile", "ProfAlign"])
            || self.is_path(&["LandXML", "Alignments", "Alignment", "Profile", "ProfSurf"])
        {
            self.finish_profile()?;
        } else if self.is_path(&[
            "LandXML",
            "Alignments",
            "Alignment",
            "CrossSects",
            "CrossSect",
            "CrossSectSurf",
        ]) || self.is_path(&[
            "LandXML",
            "Alignments",
            "Alignment",
            "CrossSects",
            "CrossSect",
            "DesignCrossSectSurf",
        ]) {
            self.finish_cross_section_surface()?;
        } else if self.is_path(&[
            "LandXML",
            "Alignments",
            "Alignment",
            "CrossSects",
            "CrossSect",
        ]) {
            self.finish_cross_section()?;
        } else if self.is_path(&["LandXML", "Alignments", "Alignment"]) {
            self.finish_alignment()?;
        } else if self.is_path(&["LandXML", "Roadways", "Roadway"]) {
            self.active_roadway_source_id = None;
        }
        Ok(())
    }

    pub(in super::super) fn finish_road_capture(&mut self, capture: Capture) -> Result<bool> {
        match capture {
            Capture::ProfilePoint { text, curve, .. } => {
                self.finish_profile_point(&text, curve)?;
                Ok(true)
            }
            Capture::PairList { text, target, .. } => {
                self.finish_pair_list(&text, target)?;
                Ok(true)
            }
            Capture::CrossSectionPoint { text, point, .. } => {
                self.finish_cross_section_point(&text, point)?;
                Ok(true)
            }
            capture => {
                self.capture = Some(capture);
                Ok(false)
            }
        }
    }

    pub(in super::super) fn record_preserved_only(
        &mut self,
        local_name: &str,
        kind: LandXmlPreservedOnlyExtensionKind,
    ) -> Result<()> {
        if self.preserved_only_extensions.len() >= self.limits.max_preserved_only_extensions {
            return Err(error(
                Code::LimitExceeded,
                "preserved-only extension limit exceeded",
            ));
        }
        let ordinal = self.preserved_only_extensions.len() + 1;
        let parent_source_id = self
            .active_roadway_source_id
            .clone()
            .or_else(|| self.alignment.as_ref().map(|value| value.source_id.clone()));
        let source_id = LandXmlSourceId(format!("landxml:preserved:{ordinal}:{local_name}"));
        self.preserved_only_extensions
            .push(LandXmlPreservedOnlyExtension {
                source_id: source_id.clone(),
                parent_source_id,
                local_name: local_name.to_owned(),
                source_path: self.path(),
                kind,
            });
        self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
            code: match kind {
                LandXmlPreservedOnlyExtensionKind::Corridor => {
                    LandXmlCapabilityDiagnosticCode::UnsupportedCorridorExtension
                }
                LandXmlPreservedOnlyExtensionKind::StringLine => {
                    LandXmlCapabilityDiagnosticCode::UnsupportedStringLineExtension
                }
            },
            source_id: Some(source_id),
            source_path: self.path(),
            message: format!(
                "{local_name} is retained as source-only; no corridor/stringline geometry is generated"
            ),
        })?;
        Ok(())
    }
}

fn missing_reference(
    source_id: &LandXmlSourceId,
    source_path: &str,
    source_kind: &str,
    reference_kind: &str,
    reference: &str,
) -> LandXmlCapabilityDiagnostic {
    LandXmlCapabilityDiagnostic {
        code: LandXmlCapabilityDiagnosticCode::MissingReference,
        source_id: Some(source_id.clone()),
        source_path: source_path.to_owned(),
        message: format!("{source_kind} references unknown {reference_kind} \"{reference}\""),
    }
}
