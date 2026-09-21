// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::HashMap;

use quick_xml::events::BytesStart;

use super::{
    actions::superelevation_event,
    state::{invalid, limit},
    Capture, Frame, Parser,
};
use crate::{
    classify_landxml_version,
    semantics::units,
    xml::{
        attr, attributes, character_references, error, split_name, unescape, Attributes, Result,
    },
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlVersionCapability,
    LANDXML_12_NAMESPACE,
};

impl Parser<'_> {
    pub(super) fn check(&mut self, added: usize) -> Result<()> {
        if self
            .cancelled
            .is_some_and(LandXmlCancellation::is_cancelled)
        {
            return Err(error(Code::Cancelled, "ingestion cancelled"));
        }
        self.work = self
            .work
            .checked_add(added)
            .ok_or_else(|| limit("work limit exceeded"))?;
        if self.work > self.limits.xml.max_work {
            return Err(limit("work limit exceeded"));
        }
        Ok(())
    }
    fn check_character_references(&mut self, added: usize) -> Result<()> {
        self.character_references = self
            .character_references
            .checked_add(added)
            .ok_or_else(|| limit("character reference limit exceeded"))?;
        if self.character_references > self.limits.xml.max_character_references {
            return Err(limit("character reference limit exceeded"));
        }
        Ok(())
    }
    pub(super) fn reserve_alignment_points(&mut self, added: usize) -> Result<()> {
        self.alignment_points_seen = self
            .alignment_points_seen
            .checked_add(added)
            .ok_or_else(|| limit("alignment point limit exceeded"))?;
        if self.alignment_points_seen > self.limits.max_alignment_points {
            return Err(limit("alignment point limit exceeded"));
        }
        Ok(())
    }
    pub(super) fn start(&mut self, start: &BytesStart<'_>) -> Result<()> {
        if self.frames.len() >= self.limits.xml.max_depth {
            return Err(limit("XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref(), self.limits.xml.max_name_bytes)?;
        let (attrs, namespaces, refs) = attributes(start, &self.limits.xml)?;
        self.check(attrs.len().saturating_add(refs))?;
        self.check_character_references(refs)?;
        let mut inherited = self
            .frames
            .last()
            .map_or_else(HashMap::new, |frame| frame.namespaces.clone());
        inherited.extend(namespaces);
        let namespace = inherited.get(prefix).map(String::as_str);
        if self.frames.is_empty() {
            if self.root_seen {
                return Err(error(
                    Code::InvalidXml,
                    "LandXML document has multiple root elements",
                ));
            }
            self.root_seen = true;
            validate_root(local, namespace, attr(&attrs, "version"))?;
        }
        let target = namespace == Some(LANDXML_12_NAMESPACE);
        self.frames.push(Frame {
            local: local.to_owned(),
            target,
            namespaces: inherited,
        });
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| self.frames.len() > capture.depth())
        {
            return Err(error(
                Code::InvalidSemantic,
                "captured alignment value may not contain descendant elements",
            ));
        }
        if target {
            self.semantic_start(local, &attrs)?;
        }
        Ok(())
    }
    fn semantic_start(&mut self, local: &str, attrs: &Attributes) -> Result<()> {
        if self.is_path(&["LandXML", "Units", local]) && matches!(local, "Metric" | "Imperial") {
            if self.units.replace(units(attrs)?).is_some() {
                return Err(invalid("LandXML may declare units only once"));
            }
            return Ok(());
        }
        if self.is_path(&["LandXML", "Alignments", "Alignment"]) {
            return self.begin_alignment(attrs);
        }
        if self.is_alignment_path(&["CoordGeom", local]) {
            return self.begin_segment(local, attrs);
        }
        if self.is_alignment_path(&["StaEquation"]) {
            return self.push_equation(attrs);
        }
        if self.is_alignment_path(&["Cant"]) {
            return self.begin_cant(attrs);
        }
        if self.is_alignment_path(&["Cant", "CantStation"]) {
            return self.push_cant_station(attrs);
        }
        if self.is_alignment_path(&["Cant", "SpeedStation"]) {
            return self.push_speed_station(attrs);
        }
        if self.is_alignment_path(&["Superelevation"]) {
            return self.begin_superelevation(attrs);
        }
        if self.is_alignment_path(&["AlignPIs", "AlignPI"]) {
            self.capture = Some(Capture::Point {
                local: "__align_pi".to_owned(),
                depth: self.frames.len(),
                pnt_ref: attr(attrs, "pntRef").map(str::to_owned),
                text: String::new(),
            });
            return Ok(());
        }
        if let Some(kind) = superelevation_event(local) {
            if self.is_alignment_path(&["Superelevation", local]) {
                self.capture = Some(Capture::Superelevation {
                    kind,
                    depth: self.frames.len(),
                    text: String::new(),
                });
            }
            return Ok(());
        }
        if self.is_alignment_path(&["Start"])
            && self
                .alignment
                .as_ref()
                .is_some_and(|value| value.segment.is_none())
        {
            self.capture = Some(Capture::Point {
                local: "__alignment_start".to_owned(),
                depth: self.frames.len(),
                pnt_ref: attr(attrs, "pntRef").map(str::to_owned),
                text: String::new(),
            });
        } else if self.is_primitive_child() {
            if matches!(local, "Start" | "End" | "Center" | "PI") {
                self.capture = Some(Capture::Point {
                    local: local.to_owned(),
                    depth: self.frames.len(),
                    pnt_ref: attr(attrs, "pntRef").map(str::to_owned),
                    text: String::new(),
                });
            } else if matches!(local, "PntList2D" | "PntList3D") {
                self.capture = Some(Capture::PointList {
                    dimension: if local == "PntList2D" { 2 } else { 3 },
                    depth: self.frames.len(),
                    text: String::new(),
                });
            }
        }
        Ok(())
    }
    pub(super) fn end(&mut self, closing: Option<&[u8]>) -> Result<()> {
        let frame = self
            .frames
            .last()
            .cloned()
            .ok_or_else(|| error(Code::InvalidXml, "unexpected closing element"))?;
        if let Some(closing) = closing {
            let (_, local, _) = split_name(closing, self.limits.xml.max_name_bytes)?;
            if local != frame.local {
                return Err(error(Code::InvalidXml, "mismatched closing element"));
            }
        }
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.depth() == self.frames.len())
        {
            self.finish_capture()?;
        }
        if frame.target {
            self.semantic_end(&frame.local)?;
        }
        let closes_root = self.frames.len() == 1;
        self.frames.pop();
        if closes_root {
            self.root_closed = true;
        }
        Ok(())
    }
    fn semantic_end(&mut self, local: &str) -> Result<()> {
        if self.is_alignment_path(&["CoordGeom", local])
            && matches!(local, "Line" | "IrregularLine" | "Curve" | "Spiral")
        {
            return self
                .alignment
                .as_mut()
                .ok_or_else(|| invalid("geometry outside Alignment"))?
                .push_segment();
        }
        if self.is_alignment_path(&["Cant"]) {
            return self
                .alignment
                .as_mut()
                .ok_or_else(|| invalid("Cant outside Alignment"))?
                .push_cant();
        }
        if self.is_alignment_path(&["Superelevation"]) {
            return self
                .alignment
                .as_mut()
                .ok_or_else(|| invalid("Superelevation outside Alignment"))?
                .push_superelevation();
        }
        if self.is_path(&["LandXML", "Alignments", "Alignment"]) {
            let alignment = self
                .alignment
                .take()
                .ok_or_else(|| invalid("missing Alignment"))?
                .alignment;
            self.alignments.push(alignment);
        }
        Ok(())
    }
    pub(super) fn text(&mut self, bytes: &[u8]) -> Result<()> {
        self.check(bytes.len())?;
        let text =
            std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))?;
        self.check_character_references(character_references(text))?;
        if self.frames.is_empty() {
            return outside_root_text(self.root_closed, text, false);
        }
        let text = unescape(text)?;
        if let Some(capture) = &mut self.capture {
            let target = match capture {
                Capture::Point { text, .. }
                | Capture::PointList { text, .. }
                | Capture::Superelevation { text, .. } => text,
            };
            if target.len().saturating_add(text.len()) > self.limits.xml.max_text_bytes {
                return Err(limit("captured text limit exceeded"));
            }
            target.push_str(&text);
        }
        Ok(())
    }
    pub(super) fn cdata(&mut self, bytes: &[u8]) -> Result<()> {
        self.check(bytes.len())?;
        let text = std::str::from_utf8(bytes)
            .map_err(|_| error(Code::InvalidXml, "CDATA is not UTF-8"))?;
        if self.frames.is_empty() {
            return outside_root_text(self.root_closed, text, true);
        }
        if let Some(capture) = &mut self.capture {
            let target = match capture {
                Capture::Point { text, .. }
                | Capture::PointList { text, .. }
                | Capture::Superelevation { text, .. } => text,
            };
            if target.len().saturating_add(text.len()) > self.limits.xml.max_text_bytes {
                return Err(limit("captured text limit exceeded"));
            }
            // CDATA is literal text. In particular, `&amp;` must reach the
            // numeric parser unchanged rather than being entity-decoded.
            target.push_str(text);
        }
        Ok(())
    }
    pub(crate) fn finish(self) -> Result<super::super::LandXmlAlignmentDocument> {
        if !self.root_seen || !self.root_closed {
            return Err(error(
                Code::InvalidXml,
                "document must contain exactly one root element",
            ));
        }
        if self.require_alignment && self.alignments.is_empty() {
            return Err(invalid("document contains no Alignments"));
        }
        Ok(super::super::LandXmlAlignmentDocument {
            units: self.units,
            alignments: self.alignments,
            warnings: self.warnings,
        })
    }
    fn is_path(&self, expected: &[&str]) -> bool {
        self.frames.len() == expected.len()
            && self
                .frames
                .iter()
                .zip(expected)
                .all(|(frame, local)| frame.target && frame.local == *local)
    }
    fn is_alignment_path(&self, tail: &[&str]) -> bool {
        let prefix = ["LandXML", "Alignments", "Alignment"];
        self.frames.len() == prefix.len() + tail.len()
            && self
                .frames
                .iter()
                .zip(prefix.iter().chain(tail.iter()))
                .all(|(frame, local)| frame.target && frame.local == *local)
    }
    fn is_primitive_child(&self) -> bool {
        self.frames.len() == 6
            && self
                .frames
                .iter()
                .take(4)
                .zip(["LandXML", "Alignments", "Alignment", "CoordGeom"])
                .all(|(frame, local)| frame.target && frame.local == local)
            && matches!(
                self.frames[4].local.as_str(),
                "Line" | "IrregularLine" | "Curve" | "Spiral"
            )
            && self.frames[4].target
            && self.frames[5].target
    }
}
fn outside_root_text(root_closed: bool, text: &str, cdata: bool) -> Result<()> {
    if !cdata
        && text
            .bytes()
            .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
    {
        return Ok(());
    }
    let location = if root_closed { "after" } else { "before" };
    let kind = if cdata {
        "CDATA"
    } else {
        "non-whitespace content"
    };
    Err(error(
        Code::InvalidXml,
        format!("LandXML document has {kind} {location} its root element"),
    ))
}
fn validate_root(local: &str, namespace: Option<&str>, version: Option<&str>) -> Result<()> {
    if local != "LandXML" {
        return Err(invalid("root element is not LandXML"));
    }
    match classify_landxml_version(namespace, version) {
        LandXmlVersionCapability::LandXml12Tin => Ok(()),
        LandXmlVersionCapability::LandXml10Unsupported
        | LandXmlVersionCapability::LandXml11Unsupported => Err(error(
            Code::UnsupportedVersion,
            "LandXML alignment parsing supports version 1.2 only",
        )),
        LandXmlVersionCapability::LandXml12VersionMismatch => Err(error(
            Code::UnsupportedVersion,
            "LandXML 1.2 namespace requires version=\"1.2\"",
        )),
        LandXmlVersionCapability::NotLandXml => Err(error(
            Code::UnsupportedNamespace,
            "root namespace is not a recognized LandXML namespace",
        )),
    }
}
