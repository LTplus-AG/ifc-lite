/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;

use quick_xml::events::BytesStart;

use super::*;

impl Parser<'_> {
    pub(super) fn start(&mut self, start: &BytesStart<'_>) -> Result<()> {
        if self.frames.len() >= self.limits.xml.max_depth {
            return Err(error(Code::LimitExceeded, "XML depth limit exceeded"));
        }
        let name = start.name();
        let (_, local, prefix) = split_name(name.as_ref(), self.limits.xml.max_name_bytes)?;
        let (attributes, namespaces, references) = attributes(start, &self.limits.xml)?;
        if attr(&attributes, "pntRef").is_some() {
            self.references = self
                .references
                .checked_add(1)
                .ok_or_else(|| error(Code::LimitExceeded, "reference limit exceeded"))?;
            if self.references > self.limits.xml.max_references {
                return Err(error(Code::LimitExceeded, "reference limit exceeded"));
            }
        }
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
            if self.root_seen {
                return Err(error(
                    Code::InvalidXml,
                    "LandXML document has multiple roots",
                ));
            }
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
            self.root_seen = true;
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
            if self.units.is_some() {
                return Err(error(
                    Code::InvalidSemantic,
                    "LandXML may declare units only once",
                ));
            }
            let declared_units = units(&attributes)?;
            self.area_unit = attr(&attributes, "areaUnit").map(str::to_owned);
            self.area_scale_to_square_meters = self
                .area_unit
                .as_deref()
                .map(area_scale)
                .transpose()?
                .or(Some(declared_units.linear_scale_to_meters.powi(2)));
            self.units = Some(declared_units);
        }
        if local == "CgPoints" {
            self.scope_ordinal += 1;
            let scope = LandXmlSourceId(format!("landxml:CgPoints:{}", self.scope_ordinal));
            self.reference_scope = Some(scope.clone());
            self.scope_stack.push((self.frames.len(), scope));
        }
        if local == "CgPoint"
            && self
                .frames
                .iter()
                .rev()
                .nth(1)
                .is_some_and(|frame| frame.target && frame.local == "CgPoints")
        {
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
        let nested_parcel = local == "Parcel"
            && self
                .frames
                .iter()
                .rev()
                .nth(1)
                .is_some_and(|frame| frame.target && frame.local == "Parcels")
            && self
                .frames
                .iter()
                .rev()
                .nth(2)
                .is_some_and(|frame| frame.target && frame.local == "Parcel")
            && matches!(self.active.last(), Some(Active::Parcel(_)));
        if self.path(&["LandXML", "Parcels", "Parcel"]) || nested_parcel {
            self.begin_parcel(attributes)?;
            return Ok(());
        }
        if local == "CoordGeom" && !self.active.is_empty() {
            if let Some(Active::Parcel(parcel)) = self.active.last_mut() {
                parcel.loops.push(Vec::new());
            }
            return Ok(());
        }
        if !self.active.is_empty()
            && self.geometry.is_none()
            && matches!(local, "Line" | "Curve" | "IrregularLine")
        {
            self.begin_geometry(local, attributes)?;
            return Ok(());
        }
        if self.geometry.is_none() && local == "Property" && !self.active.is_empty() {
            self.add_property(&attributes)?;
            return Ok(());
        }
        if self.geometry.is_none()
            && local == "Title"
            && matches!(self.active.last(), Some(Active::Parcel(_)))
        {
            if attr(&attributes, "name").is_none() {
                return Err(error(Code::InvalidSemantic, "Parcel Title requires name"));
            }
            self.capture = Some(Capture::Title {
                attributes,
                depth: self.frames.len(),
                text: String::new(),
            });
            return Ok(());
        }
        if self.geometry.is_none() && local == "Location" && !self.active.is_empty() {
            self.capture = Some(Capture::Point {
                role: "__location".to_owned(),
                depth: self.frames.len(),
                pnt_ref: attr(&attributes, "pntRef").map(str::to_owned),
                text: String::new(),
            });
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
        if self
            .geometry
            .as_ref()
            .is_some_and(|geometry| geometry.depth == self.frames.len())
        {
            self.finish_geometry()?;
        }
        if frame.target && matches!(frame.local.as_str(), "PlanFeature" | "Parcel") {
            self.finish_active()?;
        }
        if frame.target && frame.local == "CgPoints" {
            let closing_scope = self.scope_stack.last().map(|(_, scope)| scope.clone());
            self.scope_stack
                .retain(|(depth, _)| *depth != self.frames.len());
            self.reference_scope = self
                .scope_stack
                .last()
                .map(|(_, scope)| scope.clone())
                .or(closing_scope);
        }
        self.frames.pop();
        Ok(())
    }
    pub(super) fn text(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > self.limits.xml.max_text_bytes {
            return Err(error(Code::LimitExceeded, "text limit exceeded"));
        }
        self.check(bytes.len())?;
        let value =
            std::str::from_utf8(bytes).map_err(|_| error(Code::InvalidXml, "text is not UTF-8"))?;
        if self.frames.is_empty() && !value.trim().is_empty() {
            return Err(error(Code::InvalidXml, "text outside LandXML root"));
        }
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
                | Capture::Title { text, .. } => text,
            };
            if target.len() + text.len() > self.limits.xml.max_text_bytes {
                return Err(error(Code::LimitExceeded, "captured text limit exceeded"));
            }
            target.push_str(&text);
        }
        Ok(())
    }
}
