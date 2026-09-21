/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    capture::{Capture, PairListTarget, PolylineCategory, ProfileCurveCapture},
    preflight::preflight_xml_tokens,
    semantics::{positive_id, references, triple, units},
    xml::{
        attr, attributes, character_references, error, normalize_encoding, required, split_name,
        Result,
    },
    LandXmlCancellation, LandXmlCapabilities, LandXmlCoordinateSystem,
    LandXmlDiagnosticCode as Code, LandXmlExtension, LandXmlLimits, LandXmlPoint, LandXmlPolyline,
    LandXmlRenderState, LandXmlSourceId, LandXmlSurface, LandXmlSurfaceKind, LandXmlTinDocument,
};
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
mod capture;
mod document;
mod finalize;
mod limits;
mod path;
mod profiles;
pub(crate) mod state;
mod text;
mod version;

pub(crate) use document::parse_landxml_document;
pub(crate) use state::Parser;
use state::{retained_properties, Frame, SurfaceBuilder};
pub use version::*;

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
    let input = normalize_encoding(input, limits, cancelled)?;
    preflight_xml_tokens(&input, limits, cancelled)?;
    let mut parser = Parser::new(limits, cancelled);
    let mut reader = Reader::from_reader(input.as_slice());
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    loop {
        parser.check_cancel_and_work(1)?;
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| error(Code::InvalidXml, "malformed XML"))?;
        if matches!(event, Event::Eof) {
            break;
        }
        parser.consume_event(event)?;
        buffer.clear();
    }
    if !parser.frames.is_empty() {
        return Err(error(Code::InvalidXml, "unclosed XML element"));
    }
    parser.finish()
}

impl Parser<'_> {
    /// Consume an event emitted by quick-xml.  Kept crate-visible so the
    /// chunk driver and the complete reader share all semantic transitions.
    pub(crate) fn consume_event(&mut self, event: Event<'_>) -> Result<()> {
        match event {
            Event::Start(start) => self.start(&start),
            Event::Empty(start) => {
                self.start(&start)?;
                self.end(None)
            }
            Event::End(end) => self.end(Some(end.name().as_ref())),
            Event::Text(text) => self.text(text.as_ref()),
            Event::CData(text) => self.cdata(text.as_ref()),
            Event::DocType(_) => Err(error(Code::DtdForbidden, "DOCTYPE is not allowed")),
            _ => Ok(()),
        }
    }
    fn start(&mut self, start: &BytesStart<'_>) -> Result<()> {
        if self.frames.len() >= self.limits.max_depth {
            return Err(error(Code::LimitExceeded, "XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref(), self.limits.max_name_bytes)?;
        let (attributes, namespaces, references) = attributes(start, &self.limits)?;
        self.check_cancel_and_work(attributes.len())?;
        self.check_character_references(references)?;
        let mut inherited = self
            .frames
            .last()
            .map_or_else(std::collections::HashMap::new, |frame| {
                frame.namespaces.clone()
            });
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
            if local != "LandXML" {
                return Err(error(Code::InvalidSemantic, "root element is not LandXML"));
            }
            match classify_landxml_version(namespace, attr(&attributes, "version")) {
                crate::LandXmlVersionCapability::LandXml12Tin => {}
                crate::LandXmlVersionCapability::LandXml10Unsupported => {
                    return Err(error(
                        Code::UnsupportedVersion,
                        "LandXML 1.0 is recognized but TIN ingestion supports 1.2 only",
                    ));
                }
                crate::LandXmlVersionCapability::LandXml11Unsupported => {
                    return Err(error(
                        Code::UnsupportedVersion,
                        "LandXML 1.1 is recognized but TIN ingestion supports 1.2 only",
                    ));
                }
                crate::LandXmlVersionCapability::LandXml12VersionMismatch => {
                    return Err(error(
                        Code::UnsupportedVersion,
                        "LandXML 1.2 namespace requires an explicit version=\"1.2\"",
                    ));
                }
                crate::LandXmlVersionCapability::NotLandXml => {
                    return Err(error(
                        Code::UnsupportedNamespace,
                        "root namespace is not a recognized LandXML namespace",
                    ));
                }
            }
            self.version = required(&attributes, "version", "LandXML")?.to_owned();
        }
        let target = namespace == Some(LANDXML_12_NAMESPACE);
        let sibling_ordinal = self.frames.last_mut().map_or(1, |parent| {
            let ordinal = parent
                .child_ordinals
                .entry((target, local.to_owned()))
                .or_insert(0);
            *ordinal += 1;
            *ordinal
        });
        // Record one root per unknown extension subtree.  This preserves the
        // producer-visible shape without recursively copying unbounded vendor
        // payloads, and never mistakes an extension's `Surface` for LandXML.
        let extension_root = !target
            && !self.frames.is_empty()
            && self.frames.last().is_some_and(|frame| frame.target);
        if extension_root {
            if self.extensions.len() >= self.limits.max_extensions {
                return Err(error(
                    Code::LimitExceeded,
                    "extension record limit exceeded",
                ));
            }
            self.extensions.push(LandXmlExtension {
                namespace: namespace.unwrap_or("").to_owned(),
                local_name: local.to_owned(),
                path: self.path_with(local),
            });
        }
        self.frames.push(Frame {
            local: local.to_owned(),
            target,
            sibling_ordinal,
            child_ordinals: std::collections::HashMap::new(),
            overlay_name: matches!(local, "Boundary" | "Breakline" | "Contour")
                .then(|| attr(&attributes, "name").map(str::to_owned))
                .flatten(),
            overlay_kind: matches!(local, "Boundary" | "Breakline" | "Contour")
                .then(|| {
                    attr(&attributes, "bndType")
                        .or_else(|| attr(&attributes, "brkType"))
                        .or_else(|| attr(&attributes, "contType"))
                        .map(str::to_owned)
                })
                .flatten(),
            overlay_properties: matches!(local, "Boundary" | "Breakline" | "Contour")
                .then(|| retained_properties(&attributes))
                .unwrap_or_default(),
            namespaces: inherited,
        });
        if !target {
            if local == "Corridor" {
                self.record_preserved_only(
                    local,
                    crate::LandXmlPreservedOnlyExtensionKind::Corridor,
                )?;
            } else if local == "StringLine" {
                self.record_preserved_only(
                    local,
                    crate::LandXmlPreservedOnlyExtensionKind::StringLine,
                )?;
            }
            return Ok(());
        }
        match local {
            "CoordinateSystem" if self.is_path(&["LandXML", "CoordinateSystem"]) => {
                if self.coordinate_system.is_some() {
                    self.warnings.push(
                        "LandXML declares multiple root CoordinateSystem records; retained the last declaration"
                            .to_owned(),
                    );
                }
                self.coordinate_system = Some(LandXmlCoordinateSystem {
                    horizontal_datum: attr(&attributes, "horizontalDatum")
                        .map(|value| value.to_owned()),
                    vertical_datum: attr(&attributes, "verticalDatum")
                        .map(|value| value.to_owned()),
                });
            }
            "Surface" if self.is_path(&["LandXML", "Surfaces", "Surface"]) => {
                if self.surfaces_seen >= self.limits.max_surfaces {
                    return Err(error(Code::LimitExceeded, "surface limit exceeded"));
                }
                self.surfaces_seen += 1;
                self.surface = Some(SurfaceBuilder {
                    name: required(&attributes, "name", "Surface")?.to_owned(),
                    kind: LandXmlSurfaceKind::Other,
                    points: Vec::new(),
                    canonical_vertices: Vec::new(),
                    source_data_points: Vec::new(),
                    ids: std::collections::HashSet::new(),
                    faces: Vec::new(),
                    face_visibility: Vec::new(),
                    hidden_face_count: 0,
                    boundaries: Vec::new(),
                    breaklines: Vec::new(),
                    contours: Vec::new(),
                    properties: retained_properties(&attributes),
                    definition_properties: crate::LandXmlProperties::new(),
                })
            }
            "Definition" if self.is_path(&["LandXML", "Surfaces", "Surface", "Definition"]) => {
                if let Some(surface) = &mut self.surface {
                    surface.definition_properties = retained_properties(&attributes);
                    surface.kind = match attr(&attributes, "surfType")
                        .map(str::to_ascii_uppercase)
                        .as_deref()
                    {
                        Some("TIN") => LandXmlSurfaceKind::Tin,
                        Some("GRID") => LandXmlSurfaceKind::Grid,
                        Some("VOLUME") => LandXmlSurfaceKind::Volume,
                        _ => LandXmlSurfaceKind::Other,
                    };
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
                && self
                    .surface
                    .as_ref()
                    .is_some_and(|surface| surface.kind == LandXmlSurfaceKind::Tin) =>
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
            ]) && self
                .surface
                .as_ref()
                .is_some_and(|surface| surface.kind == LandXmlSurfaceKind::Tin) =>
            {
                self.capture = Some(Capture::Face {
                    depth: self.frames.len(),
                    text: String::new(),
                    hidden: matches!(attr(&attributes, "i"), Some("1" | "true")),
                })
            }
            "PntList3D" | "PntList2D" if self.source_data_point_dimension().is_some() => {
                self.capture = Some(Capture::SourcePoints {
                    depth: self.frames.len(),
                    text: String::new(),
                    source_path: self.capture_path(),
                    coordinate_dimension: self
                        .source_data_point_dimension()
                        .expect("guarded above"),
                })
            }
            "PntList3D" | "PntList2D" if self.overlay_category().is_some() => {
                let overlay = self.frames.get(self.frames.len().saturating_sub(2));
                self.capture = Some(Capture::Polyline {
                    depth: self.frames.len(),
                    text: String::new(),
                    category: self.overlay_category().expect("guarded above"),
                    name: overlay.and_then(|frame| frame.overlay_name.clone()),
                    kind: overlay.and_then(|frame| frame.overlay_kind.clone()),
                    properties: overlay.map_or_else(crate::LandXmlProperties::new, |frame| {
                        frame.overlay_properties.clone()
                    }),
                    source_path: self.capture_path(),
                    coordinate_dimension: if local == "PntList3D" { 3 } else { 2 },
                })
            }
            _ => {}
        }
        self.start_road_semantics(local, &attributes)?;
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
        self.finish_road_element()?;
        let closes_root = self.frames.len() == 1;
        self.frames.pop();
        if closes_root {
            self.root_closed = true;
        }
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
}
