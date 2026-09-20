/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded pull parsing for exact LandXML 1.2 COGO and plan element names.

use std::collections::HashMap;

use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};

use super::{
    LandXmlCgPoint, LandXmlMonument, LandXmlParcel, LandXmlPlanDocument, LandXmlPlanFeature,
};
use crate::{
    classify_landxml_version,
    preflight::preflight_xml_tokens,
    semantics::units,
    xml::{
        attr, attributes, character_references, error, normalize_encoding, split_name, unescape,
        Attributes, Result,
    },
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits, LandXmlSourceId,
    LandXmlUnits, LandXmlVersionCapability, LANDXML_12_NAMESPACE,
};

mod actions;
mod state;
use state::{Active, Capture, Frame, GeometryBuilder};

/// Plan-record bounds layered over the shared hostile-XML limits.
#[derive(Clone, Debug)]
pub struct LandXmlPlanLimits {
    pub xml: LandXmlLimits,
    pub max_cogo_points: usize,
    pub max_monuments: usize,
    pub max_plan_features: usize,
    pub max_parcels: usize,
    pub max_geometry: usize,
    pub max_vertices: usize,
}
impl Default for LandXmlPlanLimits {
    fn default() -> Self {
        Self {
            xml: LandXmlLimits::default(),
            max_cogo_points: 5_000_000,
            max_monuments: 1_000_000,
            max_plan_features: 1_000_000,
            max_parcels: 1_000_000,
            max_geometry: 5_000_000,
            max_vertices: 10_000_000,
        }
    }
}

/// Parse COGO points, monuments, parcels and plan features from LandXML 1.2.
pub fn parse_landxml_plan(input: &[u8]) -> Result<LandXmlPlanDocument> {
    parse_landxml_plan_with_cancel(input, &LandXmlPlanLimits::default(), None)
}
/// Parse plan records while bounding work and polling the caller's cancellation hook.
pub fn parse_landxml_plan_with_cancel(
    input: &[u8],
    limits: &LandXmlPlanLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlPlanDocument> {
    if input.len() > limits.xml.max_bytes {
        return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
    }
    let input = normalize_encoding(input, &limits.xml, cancelled)?;
    preflight_xml_tokens(&input, &limits.xml, cancelled)?;
    let mut parser = Parser::new(limits, cancelled);
    let mut reader = Reader::from_reader(input.as_slice());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        parser.check(1)?;
        match reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?
        {
            Event::Start(value) => parser.start(&value)?,
            Event::Empty(value) => {
                parser.start(&value)?;
                parser.end(None)?;
            }
            Event::End(value) => parser.end(Some(value.name().as_ref()))?,
            Event::Text(value) => parser.text(value.as_ref())?,
            Event::CData(value) => parser.text(value.as_ref())?,
            Event::DocType(_) => return Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !parser.frames.is_empty() {
        return Err(error(Code::InvalidXml, "unclosed XML element"));
    }
    Ok(parser.document())
}

struct Parser<'a> {
    pub(super) limits: &'a LandXmlPlanLimits,
    pub(super) cancelled: Option<&'a dyn LandXmlCancellation>,
    pub(super) work: usize,
    pub(super) characters: usize,
    pub(super) frames: Vec<Frame>,
    pub(super) units: Option<LandXmlUnits>,
    pub(super) version: String,
    pub(super) cogo_points: Vec<LandXmlCgPoint>,
    pub(super) monuments: Vec<LandXmlMonument>,
    pub(super) features: Vec<LandXmlPlanFeature>,
    pub(super) parcels: Vec<LandXmlParcel>,
    pub(super) active: Option<Active>,
    pub(super) geometry: Option<GeometryBuilder>,
    pub(super) capture: Option<Capture>,
    pub(super) scope_id: Option<LandXmlSourceId>,
    pub(super) scope_ordinal: usize,
    pub(super) cogo_ordinal: usize,
    pub(super) monument_ordinal: usize,
    pub(super) vertices: usize,
    pub(super) geometry_count: usize,
}
impl<'a> Parser<'a> {
    fn new(limits: &'a LandXmlPlanLimits, cancelled: Option<&'a dyn LandXmlCancellation>) -> Self {
        Self {
            limits,
            cancelled,
            work: 0,
            characters: 0,
            frames: Vec::new(),
            units: None,
            version: String::new(),
            cogo_points: Vec::new(),
            monuments: Vec::new(),
            features: Vec::new(),
            parcels: Vec::new(),
            active: None,
            geometry: None,
            capture: None,
            scope_id: None,
            scope_ordinal: 0,
            cogo_ordinal: 0,
            monument_ordinal: 0,
            vertices: 0,
            geometry_count: 0,
        }
    }
    fn check(&mut self, added: usize) -> Result<()> {
        if self
            .cancelled
            .is_some_and(LandXmlCancellation::is_cancelled)
        {
            return Err(error(Code::Cancelled, "ingestion cancelled"));
        }
        self.work = self
            .work
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "work limit exceeded"))?;
        if self.work > self.limits.xml.max_work {
            return Err(error(Code::LimitExceeded, "work limit exceeded"));
        }
        Ok(())
    }
    fn start(&mut self, start: &BytesStart<'_>) -> Result<()> {
        if self.frames.len() >= self.limits.xml.max_depth {
            return Err(error(Code::LimitExceeded, "XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref(), self.limits.xml.max_name_bytes)?;
        let (attributes, namespaces, references) = attributes(start, &self.limits.xml)?;
        self.check(attributes.len())?;
        self.characters = self
            .characters
            .checked_add(references)
            .ok_or_else(|| error(Code::LimitExceeded, "character reference limit exceeded"))?;
        if self.characters > self.limits.xml.max_character_references {
            return Err(error(
                Code::LimitExceeded,
                "character reference limit exceeded",
            ));
        }
        let mut inherited = self
            .frames
            .last()
            .map_or_else(HashMap::new, |frame| frame.namespaces.clone());
        inherited.extend(namespaces);
        let namespace = inherited.get(prefix).map(String::as_str);
        if self.frames.is_empty() {
            if local != "LandXML" {
                return Err(error(Code::InvalidSemantic, "root element is not LandXML"));
            }
            match classify_landxml_version(namespace, attr(&attributes, "version")) {
                LandXmlVersionCapability::LandXml12Tin => {}
                LandXmlVersionCapability::NotLandXml => {
                    return Err(error(
                        Code::UnsupportedNamespace,
                        "root namespace is not a recognized LandXML namespace",
                    ));
                }
                _ => {
                    return Err(error(
                        Code::UnsupportedVersion,
                        "COGO and plan parsing requires exact LandXML 1.2",
                    ));
                }
            }
            self.version = attr(&attributes, "version").unwrap_or_default().to_owned();
        }
        let target = namespace == Some(LANDXML_12_NAMESPACE);
        self.frames.push(Frame {
            local: local.to_owned(),
            target,
            namespaces: inherited,
        });
        if !target {
            return Ok(());
        }
        if self.path(&["LandXML", "Units", local]) && matches!(local, "Metric" | "Imperial") {
            self.units = Some(units(&attributes)?);
        }
        if self.path(&["LandXML", "CgPoints"]) {
            self.scope_ordinal += 1;
            self.scope_id = Some(LandXmlSourceId(format!(
                "landxml:CgPoints:{}",
                self.scope_ordinal
            )));
        }
        if self.path(&["LandXML", "CgPoints", "CgPoint"]) {
            self.capture = Some(Capture::CgPoint {
                attributes,
                depth: self.frames.len(),
                text: String::new(),
            });
            return Ok(());
        }
        if self.path(&["LandXML", "Monuments", "Monument"]) {
            self.capture = Some(Capture::Monument {
                attributes,
                depth: self.frames.len(),
                text: String::new(),
            });
            return Ok(());
        }
        if self.path(&["LandXML", "PlanFeatures", "PlanFeature"]) {
            self.begin_feature(attributes)?;
            return Ok(());
        }
        if self.path(&["LandXML", "Parcels", "Parcel"]) {
            self.begin_parcel(attributes)?;
            return Ok(());
        }
        if local == "CoordGeom" && self.active.is_some() {
            if let Some(Active::Parcel(parcel)) = &mut self.active {
                parcel.loops.push(Vec::new());
            }
            return Ok(());
        }
        if self.active.is_some()
            && self.geometry.is_none()
            && matches!(local, "Line" | "Curve" | "IrregularLine")
        {
            self.begin_geometry(local, attributes)?;
            return Ok(());
        }
        if let Some(geometry) = &self.geometry {
            if self.frames.len() == geometry.depth + 1
                && matches!(local, "Start" | "End" | "Center" | "PI")
            {
                self.capture = Some(Capture::Point {
                    role: local.to_owned(),
                    depth: self.frames.len(),
                    pnt_ref: attr(&attributes, "pntRef").map(str::to_owned),
                    text: String::new(),
                });
            } else if self.frames.len() == geometry.depth + 1
                && matches!(local, "PntList2D" | "PntList3D")
            {
                self.capture = Some(Capture::PointList {
                    depth: self.frames.len(),
                    dimension: if local == "PntList2D" { 2 } else { 3 },
                    text: String::new(),
                });
            }
        } else if matches!(self.active, Some(Active::Parcel(_))) && local == "Label" {
            self.capture = Some(Capture::Label {
                depth: self.frames.len(),
                text: String::new(),
            });
        }
        Ok(())
    }
    fn end(&mut self, closing: Option<&[u8]>) -> Result<()> {
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
        if self
            .geometry
            .as_ref()
            .is_some_and(|geometry| geometry.depth == self.frames.len())
        {
            self.finish_geometry()?;
        }
        if self.path(&["LandXML", "PlanFeatures", "PlanFeature"])
            || self.path(&["LandXML", "Parcels", "Parcel"])
        {
            self.finish_active()?;
        }
        self.frames.pop();
        Ok(())
    }
    fn text(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.limits.xml.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check(bytes.len())?;
        let value =
            std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))?;
        self.characters = self
            .characters
            .checked_add(character_references(value))
            .ok_or_else(|| error(Code::LimitExceeded, "character reference limit exceeded"))?;
        if self.characters > self.limits.xml.max_character_references {
            return Err(error(
                Code::LimitExceeded,
                "character reference limit exceeded",
            ));
        }
        if let Some(capture) = &mut self.capture {
            let text = unescape(value)?;
            let target = match capture {
                Capture::CgPoint { text, .. }
                | Capture::Monument { text, .. }
                | Capture::Point { text, .. }
                | Capture::PointList { text, .. }
                | Capture::Label { text, .. } => text,
            };
            if target.len() + text.len() > self.limits.xml.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            target.push_str(&text);
        }
        Ok(())
    }
}
