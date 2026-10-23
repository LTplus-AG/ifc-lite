/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::rc::Rc;

use crate::{
    capture::{Capture, PairListTarget, PolylineCategory, ProfileCurveCapture},
    semantics::{positive_id, references, triple, units},
    xml::{
        attr, drive, error, normalize_encoding, path_is_of, required, Attributes, Cx, Element, FamilyHandler, Meter,
        Result,
    },
    LandXmlCancellation, LandXmlCapabilities, LandXmlCoordinateSystem,
    LandXmlDiagnosticCode as Code, LandXmlExtension, LandXmlLimits, LandXmlPoint, LandXmlPolyline,
    LandXmlRenderState, LandXmlSourceId, LandXmlSurface, LandXmlSurfaceKind, LandXmlTinDocument,
};
mod capture;
mod finalize;
mod limits;
mod path;
mod profiles;
pub(crate) mod state;
mod text;
mod version;

pub(crate) use finalize::{require_units_for_renderable_tin, surface_draws_to_scale};
pub(crate) use state::TinHandler;
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
    // #5175: validate a caller-supplied assumed-unit override up front, so
    // an unknown token refuses before any XML is read rather than partway
    // through a parse.
    let assumed_units = crate::semantics::resolve_assumed_units(limits)?;
    let input = normalize_encoding(input, limits, cancelled)?;
    let meter = Meter::new(limits.max_work, cancelled);
    let mut handler = TinHandler::new(limits, meter.clone(), cancelled, assumed_units);
    drive(&input, limits, cancelled, meter, &mut [&mut handler])?;
    handler.finish()
}

impl FamilyHandler for TinHandler<'_> {
    /// D74: markup inside a numeric capture is refused, as in the plan and
    /// alignment families, rather than read as the text around it.
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
            self.open_root(cx)?;
        }
        self.push_frame(cx, element)?;
        if !element.target {
            return self.start_foreign(element.local);
        }
        self.start_target(cx, element.local, element.attributes)?;
        self.start_road_semantics(element.local, element.attributes)
    }

    fn end(&mut self, _cx: &Cx<'_>) -> Result<()> {
        if self.capture.as_ref().is_some_and(|capture| capture.depth() == self.frames.len()) {
            self.finish_capture()?;
        }
        if self.is_path(&["LandXML", "Surfaces", "Surface"]) {
            self.finish_surface()?;
        }
        self.finish_road_element()?;
        self.frames.pop();
        Ok(())
    }

    fn text(&mut self, _cx: &Cx<'_>, text: &str) -> Result<()> {
        self.capture_text(text)
    }

    fn capture_depth(&self) -> Option<usize> {
        self.capture.as_ref().map(Capture::depth)
    }
}

impl TinHandler<'_> {
    /// Take what the driver validated at the document element.
    fn open_root(&mut self, cx: &Cx<'_>) -> Result<()> {
        self.schema = cx.root.schema.clone();
        self.target_namespace = cx.root.target_namespace.clone();
        if let Some(diagnostic) = cx.root.diagnostic.clone() {
            self.record_capability_diagnostic(diagnostic)?;
        }
        self.version = cx.root.version.clone();
        Ok(())
    }

    /// Open this family's frame for the element the driver just pushed, and
    /// record one root per unknown extension subtree. That preserves the
    /// producer-visible shape without recursively copying unbounded vendor
    /// payloads, and never mistakes an extension's `Surface` for LandXML.
    fn push_frame(&mut self, cx: &Cx<'_>, element: &Element<'_>) -> Result<()> {
        let (local, target, attributes) = (element.local, element.target, element.attributes);
        // Only a name that can appear in a capture path is counted: the map
        // lives as long as the parent, so counting every distinct child name
        // let a flat root hold one entry per name (#7675, EDGE-LXPARSE-17).
        let tracked = target && path::ordinal_tracked(local);
        let sibling_ordinal = self.frames.last_mut().map_or(1, |parent| {
            if !tracked {
                return 0;
            }
            let ordinal = parent.child_ordinals.entry((target, local.to_owned())).or_insert(0);
            *ordinal += 1;
            *ordinal
        });
        let extension_root = !target && self.frames.last().is_some_and(|frame| frame.target);
        if extension_root {
            if self.extensions.len() >= self.limits.max_extensions {
                return Err(error(Code::LimitExceeded, "extension record limit exceeded"));
            }
            let path = self.path_with(local);
            self.reserve_source_path(path.len())?;
            self.extensions.push(LandXmlExtension {
                namespace: element.namespace.unwrap_or("").to_owned(),
                local_name: local.to_owned(),
                path,
            });
        }
        let overlay = matches!(local, "Boundary" | "Breakline" | "Contour");
        self.frames.push(Frame {
            local: Rc::clone(&cx.frames().last().expect("the driver pushed this element").local),
            target,
            sibling_ordinal,
            child_ordinals: std::collections::HashMap::new(),
            overlay_name: overlay.then(|| attr(attributes, "name").map(str::to_owned)).flatten(),
            overlay_kind: overlay
                .then(|| {
                    attr(attributes, "bndType")
                        .or_else(|| attr(attributes, "brkType"))
                        .or_else(|| attr(attributes, "contType"))
                        .map(str::to_owned)
                })
                .flatten(),
            overlay_properties: if overlay { retained_properties(attributes) } else { Default::default() },
        });
        Ok(())
    }

    fn start_foreign(&mut self, local: &str) -> Result<()> {
        match local {
            "Corridor" => self.record_preserved_only(local, crate::LandXmlPreservedOnlyExtensionKind::Corridor),
            "StringLine" => self.record_preserved_only(local, crate::LandXmlPreservedOnlyExtensionKind::StringLine),
            _ => Ok(()),
        }
    }

    fn start_target(&mut self, cx: &Cx<'_>, local: &str, attributes: &Attributes) -> Result<()> {
        match local {
            "CoordinateSystem" if cx.path_is(&["LandXML", "CoordinateSystem"]) => {
                self.start_coordinate_system(attributes);
                Ok(())
            }
            "Surface" if cx.path_is(&["LandXML", "Surfaces", "Surface"]) => self.start_surface(attributes),
            "Definition" if cx.path_is(&["LandXML", "Surfaces", "Surface", "Definition"]) => {
                self.start_definition(attributes);
                Ok(())
            }
            "Metric" | "Imperial" if cx.path_is(&["LandXML", "Units", local]) => self.declare_units(attributes),
            "P" if self.is_tin_leaf(cx, &["LandXML", "Surfaces", "Surface", "Definition", "Pnts", "P"]) => {
                self.capture = Some(Capture::Point {
                    id: positive_id(required(attributes, "id", "point")?)?,
                    depth: self.frames.len(),
                    text: String::new(),
                });
                Ok(())
            }
            "F" if self.is_tin_leaf(cx, &["LandXML", "Surfaces", "Surface", "Definition", "Faces", "F"]) => {
                self.capture = Some(Capture::Face {
                    depth: self.frames.len(),
                    text: String::new(),
                    hidden: matches!(attr(attributes, "i"), Some("1" | "true")),
                });
                Ok(())
            }
            "PntList3D" | "PntList2D" => {
                self.start_point_list(local);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Counted, and warned about once in `finish` (#7675, EDGE-LXPARSE-24:
    /// one warning per repeat was ~4x the input).
    fn start_coordinate_system(&mut self, attributes: &Attributes) {
        self.coordinate_systems_seen += 1;
        let owned = |key| attr(attributes, key).map(str::to_owned);
        self.coordinate_system = Some(LandXmlCoordinateSystem {
            horizontal_datum: owned("horizontalDatum"),
            vertical_datum: owned("verticalDatum"),
            epsg_code: owned("epsgCode"),
            name: owned("name"),
        });
    }

    fn start_surface(&mut self, attributes: &Attributes) -> Result<()> {
        self.surfaces_seen.reserve(1)?;
        self.surface = Some(SurfaceBuilder {
            name: required(attributes, "name", "Surface")?.to_owned(),
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
            properties: retained_properties(attributes),
            definition_properties: crate::LandXmlProperties::new(),
        });
        Ok(())
    }

    fn start_definition(&mut self, attributes: &Attributes) {
        if let Some(surface) = &mut self.surface {
            surface.definition_properties = retained_properties(attributes);
            surface.kind = match attr(attributes, "surfType").map(str::to_ascii_uppercase).as_deref() {
                Some("TIN") => LandXmlSurfaceKind::Tin,
                Some("GRID") => LandXmlSurfaceKind::Grid,
                Some("VOLUME") => LandXmlSurfaceKind::Volume,
                _ => LandXmlSurfaceKind::Other,
            };
        }
    }

    /// The driver has already refused a second declaration.
    fn declare_units(&mut self, attributes: &Attributes) -> Result<()> {
        self.units = Some(units(attributes)?);
        // #5175: a declared <Units> element always wins over a
        // caller-supplied assumed-unit override. Silently dropping
        // the override here would hide that the two might disagree,
        // so warn once, non-fatally, at the exact point we learn the
        // declaration exists.
        if self.assumed_units.is_some() {
            self.warnings.push(
                "an assumed linear unit override was supplied but LandXML/Units is \
                 declared; the declared units were used and the override was ignored"
                    .to_owned(),
            );
        }
        Ok(())
    }

    /// A point or face leaf of a TIN `Definition`.
    fn is_tin_leaf(&self, cx: &Cx<'_>, path: &[&str]) -> bool {
        cx.path_is(path)
            && self.surface.as_ref().is_some_and(|surface| surface.kind == LandXmlSurfaceKind::Tin)
    }

    /// `SourceData` coordinate lists and the polylines of overlays.
    fn start_point_list(&mut self, local: &str) {
        let depth = self.frames.len();
        if let Some(coordinate_dimension) = self.source_data_point_dimension() {
            self.capture = Some(Capture::SourcePoints {
                depth,
                text: String::new(),
                source_path: self.capture_path(),
                coordinate_dimension,
            });
        } else if let Some(category) = self.overlay_category() {
            let overlay = self.frames.get(self.frames.len().saturating_sub(2));
            self.capture = Some(Capture::Polyline {
                depth,
                text: String::new(),
                category,
                name: overlay.and_then(|frame| frame.overlay_name.clone()),
                kind: overlay.and_then(|frame| frame.overlay_kind.clone()),
                properties: overlay
                    .map_or_else(crate::LandXmlProperties::new, |frame| frame.overlay_properties.clone()),
                source_path: self.capture_path(),
                coordinate_dimension: if local == "PntList3D" { 3 } else { 2 },
            });
        }
    }

    fn is_path(&self, expected: &[&str]) -> bool {
        path_is_of(self.frames.iter().map(|frame| (&*frame.local, frame.target)), expected)
    }
}
