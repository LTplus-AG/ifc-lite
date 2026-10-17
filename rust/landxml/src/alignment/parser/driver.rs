// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The alignment family as a [`FamilyHandler`] (C9a-7).

use super::{
    actions::superelevation_event,
    state::{invalid, limit},
    AlignmentHandler, Capture, PointRole,
};
use crate::{
    semantics::units,
    xml::{attr, error, Attributes, Cx, Element, FamilyHandler, Result},
    LandXmlDiagnosticCode as Code,
};

impl FamilyHandler for AlignmentHandler {
    /// D74: markup inside a numeric capture refuses the document.
    fn check_nesting(&mut self, depth: usize) -> Result<()> {
        if self.capture.as_ref().is_some_and(|capture| capture.depth() <= depth) {
            return Err(error(
                Code::InvalidSemantic,
                "numeric LandXML capture cannot contain nested elements",
            ));
        }
        Ok(())
    }

    fn start(&mut self, cx: &Cx<'_>, element: &Element<'_>) -> Result<()> {
        if element.depth == 1 {
            self.schema = cx.root.schema.clone();
            self.version = cx.root.version.clone();
            if let Some(diagnostic) = cx.root.diagnostic.clone() {
                self.record_capability_diagnostic(diagnostic)?;
            }
        }
        if element.target {
            self.semantic_start(cx, element.local, element.attributes)?;
        }
        Ok(())
    }

    fn end(&mut self, cx: &Cx<'_>) -> Result<()> {
        if self.capture.as_ref().is_some_and(|capture| capture.depth() == cx.frames().len()) {
            self.finish_capture()?;
        }
        let frame = cx.frames().last().expect("an element is closing");
        if frame.target {
            self.semantic_end(cx, &frame.local)?;
        }
        Ok(())
    }

    fn text(&mut self, _cx: &Cx<'_>, text: &str) -> Result<()> {
        self.capture_decoded(text)
    }

    fn capture_depth(&self) -> Option<usize> {
        self.capture.as_ref().map(Capture::depth)
    }
}

impl AlignmentHandler {
    /// A diagnostic is source output too: bounded like every other record.
    fn record_capability_diagnostic(&mut self, diagnostic: crate::LandXmlCapabilityDiagnostic) -> Result<()> {
        self.capability_diagnostics_seen.reserve(1)?;
        self.capability_diagnostics.push(diagnostic);
        Ok(())
    }

    pub(super) fn reserve_alignment_points(&mut self, added: usize) -> Result<()> {
        self.alignment_points_seen.reserve(added)
    }

    fn semantic_start(&mut self, cx: &Cx<'_>, local: &str, attrs: &Attributes) -> Result<()> {
        let depth = cx.frames().len();
        if matches!(local, "Metric" | "Imperial") && cx.path_is(&["LandXML", "Units", local]) {
            // The driver has already refused a second declaration.
            self.units = Some(units(attrs)?);
            return Ok(());
        }
        if cx.path_is(&["LandXML", "Alignments", "Alignment"]) {
            return self.begin_alignment(attrs);
        }
        if under_alignment(cx, &["CoordGeom", local]) {
            return self.begin_segment(local, attrs);
        }
        if under_alignment(cx, &["StaEquation"]) {
            return self.push_equation(attrs);
        }
        if under_alignment(cx, &["Cant"]) {
            return self.begin_cant(attrs);
        }
        if under_alignment(cx, &["Cant", "CantStation"]) {
            return self.push_cant_station(attrs);
        }
        if under_alignment(cx, &["Cant", "SpeedStation"]) {
            return self.push_speed_station(attrs);
        }
        if under_alignment(cx, &["Superelevation"]) {
            return self.begin_superelevation(attrs);
        }
        if under_alignment(cx, &["AlignPIs", "AlignPI"]) {
            self.capture_point(PointRole::AlignPi, depth, attrs);
            return Ok(());
        }
        if let Some(kind) = superelevation_event(local) {
            if under_alignment(cx, &["Superelevation", local]) {
                self.capture = Some(Capture::Superelevation { kind, depth, text: String::new() });
            }
            return Ok(());
        }
        if under_alignment(cx, &["Start"]) && self.alignment.as_ref().is_some_and(|value| value.segment.is_none()) {
            self.capture_point(PointRole::AlignmentStart, depth, attrs);
        } else if is_primitive_child(cx) {
            match local {
                "Start" => self.capture_point(PointRole::Primitive("Start"), depth, attrs),
                "End" => self.capture_point(PointRole::Primitive("End"), depth, attrs),
                "Center" => self.capture_point(PointRole::Primitive("Center"), depth, attrs),
                "PI" => self.capture_point(PointRole::Primitive("PI"), depth, attrs),
                "PntList2D" | "PntList3D" => {
                    let dimension = if local == "PntList2D" { 2 } else { 3 };
                    self.capture = Some(Capture::PointList { dimension, depth, text: String::new() });
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn capture_point(&mut self, role: PointRole, depth: usize, attrs: &Attributes) {
        self.capture = Some(Capture::Point {
            role,
            depth,
            pnt_ref: attr(attrs, "pntRef").map(str::to_owned),
            text: String::new(),
        });
    }

    fn semantic_end(&mut self, cx: &Cx<'_>, local: &str) -> Result<()> {
        if under_alignment(cx, &["CoordGeom", local])
            && matches!(local, "Line" | "IrregularLine" | "Curve" | "Spiral")
        {
            return self
                .alignment
                .as_mut()
                .ok_or_else(|| invalid("geometry outside Alignment"))?
                .push_segment();
        }
        if under_alignment(cx, &["Cant"]) {
            return self.alignment.as_mut().ok_or_else(|| invalid("Cant outside Alignment"))?.push_cant();
        }
        if under_alignment(cx, &["Superelevation"]) {
            return self
                .alignment
                .as_mut()
                .ok_or_else(|| invalid("Superelevation outside Alignment"))?
                .push_superelevation();
        }
        if cx.path_is(&["LandXML", "Alignments", "Alignment"]) {
            let alignment = self.alignment.take().ok_or_else(|| invalid("missing Alignment"))?.alignment;
            self.alignments.push(alignment);
        }
        Ok(())
    }

    fn capture_decoded(&mut self, text: &str) -> Result<()> {
        if let Some(capture) = &mut self.capture {
            let target = match capture {
                Capture::Point { text, .. }
                | Capture::PointList { text, .. }
                | Capture::Superelevation { text, .. } => text,
            };
            if target.len().saturating_add(text.len()) > self.limits.xml.max_text_bytes {
                return Err(limit("captured text limit exceeded"));
            }
            target.push_str(text);
        }
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<super::super::LandXmlAlignmentDocument> {
        if self.require_alignment && self.alignments.is_empty() {
            return Err(invalid("document contains no Alignments"));
        }
        Ok(super::super::LandXmlAlignmentDocument {
            schema: self.schema,
            version: self.version,
            capability_diagnostics: self.capability_diagnostics,
            // A declared `<Units>` always wins over the assumption.
            units: self.units.or(self.assumed_units),
            alignments: self.alignments,
            warnings: self.warnings,
        })
    }
}

/// The open elements are `LandXML/Alignments/Alignment` followed by `tail`.
fn under_alignment(cx: &Cx<'_>, tail: &[&str]) -> bool {
    const PREFIX: [&str; 3] = ["LandXML", "Alignments", "Alignment"];
    let frames = cx.frames();
    frames.len() == PREFIX.len() + tail.len()
        && frames.iter().zip(PREFIX.iter().chain(tail)).all(|(frame, local)| frame.target && &*frame.local == *local)
}

/// A direct child of a `CoordGeom` primitive.
fn is_primitive_child(cx: &Cx<'_>) -> bool {
    let frames = cx.frames();
    frames.len() == 6
        && frames[..4]
            .iter()
            .zip(["LandXML", "Alignments", "Alignment", "CoordGeom"])
            .all(|(frame, local)| frame.target && &*frame.local == local)
        && matches!(&*frames[4].local, "Line" | "IrregularLine" | "Curve" | "Spiral")
        && frames[4].target
        && frames[5].target
}
