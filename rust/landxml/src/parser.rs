/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::{HashMap, HashSet};

use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};

use crate::{
    capture::Capture,
    semantics::{positive_id, references, triple, units},
    xml::{
        attr, attributes, character_references, error, normalize_encoding, required, split_name,
        unescape, Result,
    },
    LandXmlCancellation, LandXmlDiagnosticCode as Code, LandXmlLimits, LandXmlPoint,
    LandXmlSourceId, LandXmlSurface, LandXmlTinDocument, LandXmlUnits,
};

pub const LANDXML_12_NAMESPACE: &str = "http://www.landxml.org/schema/LandXML-1.2";

#[derive(Clone)]
struct Frame {
    local: String,
    target: bool,
    namespaces: HashMap<String, String>,
}
struct SurfaceBuilder {
    name: String,
    tin: bool,
    points: Vec<LandXmlPoint>,
    ids: HashSet<String>,
    faces: Vec<[String; 3]>,
}
struct Parser<'a> {
    limits: &'a LandXmlLimits,
    cancelled: Option<&'a dyn LandXmlCancellation>,
    work: usize,
    character_references: usize,
    references: usize,
    frames: Vec<Frame>,
    units: Option<LandXmlUnits>,
    surface: Option<SurfaceBuilder>,
    capture: Option<Capture>,
    surfaces: Vec<LandXmlSurface>,
    warnings: Vec<String>,
    surface_ordinal: usize,
}

/// Parse exact LandXML 1.2 TIN semantics with default resource limits.
pub fn parse_landxml_tin(input: &[u8]) -> Result<LandXmlTinDocument> {
    parse_landxml_tin_with_cancel(input, &LandXmlLimits::default(), None)
}

/// Parse exact LandXML 1.2 TIN semantics with host limits and cancellation.
pub fn parse_landxml_tin_with_cancel(
    input: &[u8],
    limits: &LandXmlLimits,
    cancelled: Option<&dyn LandXmlCancellation>,
) -> Result<LandXmlTinDocument> {
    if input.len() > limits.max_bytes {
        return Err(error(Code::InputTooLarge, "input exceeds byte limit"));
    }
    let input = normalize_encoding(input, limits)?;
    let mut parser = Parser {
        limits,
        cancelled,
        work: 0,
        character_references: 0,
        references: 0,
        frames: Vec::new(),
        units: None,
        surface: None,
        capture: None,
        surfaces: Vec::new(),
        warnings: Vec::new(),
        surface_ordinal: 0,
    };
    let mut reader = Reader::from_reader(input.as_slice());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        parser.check_cancel_and_work(1)?;
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?;
        match event {
            Event::Start(start) => parser.start(&start)?,
            Event::Empty(start) => {
                parser.start(&start)?;
                parser.end(None)?;
            }
            Event::End(end) => parser.end(Some(end.name().as_ref()))?,
            Event::Text(text) => parser.text(text.as_ref())?,
            Event::CData(text) => parser.text(text.as_ref())?,
            Event::DocType(_) => return Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !parser.frames.is_empty() {
        return Err(error(Code::InvalidXml, "unclosed XML element"));
    }
    parser.finish()
}

impl Parser<'_> {
    fn check_cancel_and_work(&mut self, added: usize) -> Result<()> {
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
        if self.work > self.limits.max_work {
            return Err(error(Code::LimitExceeded, "work limit exceeded"));
        }
        Ok(())
    }

    fn check_character_references(&mut self, added: usize) -> Result<()> {
        self.character_references = self
            .character_references
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "character reference limit exceeded"))?;
        if self.character_references > self.limits.max_character_references {
            return Err(error(
                Code::LimitExceeded,
                "character reference limit exceeded",
            ));
        }
        Ok(())
    }

    fn start(&mut self, start: &BytesStart<'_>) -> Result<()> {
        if self.frames.len() >= self.limits.max_depth {
            return Err(error(Code::LimitExceeded, "XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref(), self.limits.max_name_bytes)?;
        let (attributes, namespaces, references) = attributes(start, self.limits)?;
        self.check_cancel_and_work(attributes.len())?;
        self.check_character_references(references)?;
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
            if namespace != Some(LANDXML_12_NAMESPACE) {
                return Err(error(
                    Code::UnsupportedNamespace,
                    "root namespace is not LandXML 1.2",
                ));
            }
            if attr(&attributes, "version") != Some("1.2") {
                return Err(error(
                    Code::UnsupportedVersion,
                    "LandXML version must explicitly be 1.2",
                ));
            }
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
        match local {
            "Surface" if self.is_path(&["LandXML", "Surfaces", "Surface"]) => {
                self.surface = Some(SurfaceBuilder {
                    name: required(&attributes, "name", "Surface")?.to_owned(),
                    tin: false,
                    points: Vec::new(),
                    ids: HashSet::new(),
                    faces: Vec::new(),
                })
            }
            "Definition" if self.is_path(&["LandXML", "Surfaces", "Surface", "Definition"]) => {
                if let Some(surface) = &mut self.surface {
                    surface.tin = attr(&attributes, "surfType") == Some("TIN");
                }
            }
            "Metric" | "Imperial" if self.is_path(&["LandXML", "Units", local]) => {
                if self.units.is_some() {
                    return Err(error(
                        Code::InvalidSemantic,
                        "LandXML may declare units only once",
                    ));
                }
                self.units = Some(units(&attributes)?)
            }
            "P" if self.is_path(&["LandXML", "Surfaces", "Surface", "Definition", "Pnts", "P"])
                && self.surface.as_ref().is_some_and(|surface| surface.tin) =>
            {
                self.capture = Some(Capture::Point {
                    id: positive_id(required(&attributes, "id", "point")?)?,
                    depth: self.frames.len(),
                    text: String::new(),
                })
            }
            "F" if self.is_path(&[
                "LandXML",
                "Surfaces",
                "Surface",
                "Definition",
                "Faces",
                "F",
            ]) && self.surface.as_ref().is_some_and(|surface| surface.tin) =>
            {
                self.capture = Some(Capture::Face {
                    depth: self.frames.len(),
                    text: String::new(),
                    hidden: matches!(attr(&attributes, "i"), Some("1" | "true")),
                })
            }
            _ => {}
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
            let (_, local, _) = split_name(closing, self.limits.max_name_bytes)?;
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
        if self.is_path(&["LandXML", "Surfaces", "Surface"]) {
            self.finish_surface()?;
        }
        self.frames.pop();
        Ok(())
    }

    fn text(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.limits.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check_cancel_and_work(bytes.len())?;
        let text =
            std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))?;
        self.check_character_references(character_references(text))?;
        let text = unescape(text)?;
        if let Some(capture) = &mut self.capture {
            let target = match capture {
                Capture::Point { text, .. } | Capture::Face { text, .. } => text,
            };
            if target.len() + text.len() > self.limits.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            target.push_str(&text);
        }
        Ok(())
    }

    fn finish_capture(&mut self) -> Result<()> {
        let capture = self.capture.take().expect("capture checked");
        let surface = self
            .surface
            .as_mut()
            .ok_or_else(|| error(Code::InvalidSemantic, "geometry outside Surface"))?;
        match capture {
            Capture::Point { id, text, .. } => {
                if surface.points.len() >= self.limits.max_points {
                    return Err(error(Code::LimitExceeded, "point limit exceeded"));
                }
                if !surface.ids.insert(id.clone()) {
                    return Err(error(Code::InvalidSemantic, "duplicate point id"));
                }
                let values = triple(&text, "point")?;
                surface.points.push(LandXmlPoint {
                    id,
                    northing: values[0],
                    easting: values[1],
                    elevation: values[2],
                });
            }
            Capture::Face { text, hidden, .. } if !hidden => {
                if surface.faces.len() >= self.limits.max_faces {
                    return Err(error(Code::LimitExceeded, "face limit exceeded"));
                }
                self.references = self
                    .references
                    .checked_add(3)
                    .ok_or_else(|| error(Code::LimitExceeded, "reference limit exceeded"))?;
                if self.references > self.limits.max_references {
                    return Err(error(Code::LimitExceeded, "reference limit exceeded"));
                }
                let refs = references(&text)?;
                surface.faces.push(refs);
            }
            Capture::Face { .. } => {}
        }
        Ok(())
    }

    fn finish_surface(&mut self) -> Result<()> {
        let surface = self.surface.take().expect("surface closing");
        if !surface.tin {
            self.warnings.push(format!(
                "Skipped non-TIN or undefined surface \"{}\"",
                surface.name
            ));
            return Ok(());
        }
        if surface.points.len() < 3 {
            return Err(error(
                Code::InvalidSemantic,
                "TIN surface needs at least three points",
            ));
        }
        if surface.faces.is_empty() {
            return Err(error(
                Code::InvalidSemantic,
                "TIN surface has no visible faces",
            ));
        }
        for face in &surface.faces {
            for id in face {
                if !surface.ids.contains(id) {
                    return Err(error(
                        Code::InvalidSemantic,
                        "face references unknown point",
                    ));
                }
            }
        }
        self.surface_ordinal += 1;
        self.surfaces.push(LandXmlSurface {
            source_id: LandXmlSourceId(format!(
                "landxml:surface:{}:{}",
                self.surface_ordinal, surface.name
            )),
            name: surface.name,
            points: surface.points,
            faces: surface.faces,
        });
        Ok(())
    }

    fn is_path(&self, expected: &[&str]) -> bool {
        self.frames.len() == expected.len()
            && self
                .frames
                .iter()
                .zip(expected)
                .all(|(frame, local)| frame.target && frame.local == *local)
    }
    fn finish(self) -> Result<LandXmlTinDocument> {
        if self.surfaces.is_empty() {
            return Err(error(
                Code::InvalidSemantic,
                "document contains no renderable TIN surfaces",
            ));
        }
        Ok(LandXmlTinDocument {
            version: "1.2".to_owned(),
            units: self
                .units
                .ok_or_else(|| error(Code::InvalidSemantic, "document is missing Units"))?,
            surfaces: self.surfaces,
            warnings: self.warnings,
        })
    }
}
