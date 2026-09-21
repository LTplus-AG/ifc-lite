/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::{HashMap, HashSet};

use crate::{
    capture::Capture, xml::Attributes, LandXmlAlignment, LandXmlCancellation,
    LandXmlCapabilityDiagnostic, LandXmlCoordinateSystem, LandXmlCrossSection,
    LandXmlCrossSectionSurface, LandXmlExtension, LandXmlLimits, LandXmlPoint, LandXmlPolyline,
    LandXmlPreservedOnlyExtension, LandXmlProfile, LandXmlRenderState, LandXmlRoadway,
    LandXmlSourceId, LandXmlSurface, LandXmlSurfaceKind, LandXmlUnits,
};

use super::profiles::{
    AlignmentBuilder, CrossSectionBuilder, CrossSectionSurfaceBuilder, ProfileBuilder,
};

/// The canonical semantic state machine.  Streaming hosts drive this exact
/// parser one quick-xml event at a time; they must not grow a parallel
/// LandXML interpretation just because transport arrives in chunks.
pub(crate) struct Parser<'a> {
    pub(super) limits: LandXmlLimits,
    pub(super) cancelled: Option<&'a dyn LandXmlCancellation>,
    pub(super) work: usize,
    pub(super) character_references: usize,
    pub(super) references: usize,
    pub(super) surfaces_seen: usize,
    pub(super) points_seen: usize,
    pub(super) faces_seen: usize,
    pub(super) profile_points_seen: usize,
    pub(super) vertical_curves_seen: usize,
    pub(super) cross_section_points_seen: usize,
    pub(super) frames: Vec<Frame>,
    pub(super) units: Option<LandXmlUnits>,
    pub(super) coordinate_system: Option<LandXmlCoordinateSystem>,
    pub(super) surface: Option<SurfaceBuilder>,
    pub(super) capture: Option<Capture>,
    pub(super) surfaces: Vec<LandXmlSurface>,
    /// Minimal identity index retained after a streaming host drains complete
    /// surfaces. Roadway finalization needs names, but must not force a second
    /// full copy of every terrain record into the parser.
    pub(super) drained_surface_refs: Vec<(String, LandXmlSourceId)>,
    /// Capability facts survive surface draining so final metadata remains
    /// equivalent to a complete-input document without retaining surface data.
    pub(super) drained_renderable_surfaces: usize,
    pub(super) drained_preserved_surfaces: usize,
    pub(super) extensions: Vec<LandXmlExtension>,
    pub(super) warnings: Vec<String>,
    pub(super) surface_ordinal: usize,
    pub(super) version: String,
    pub(super) root_seen: bool,
    pub(super) root_closed: bool,
    pub(super) alignment: Option<AlignmentBuilder>,
    pub(super) profile: Option<ProfileBuilder>,
    pub(super) cross_section: Option<CrossSectionBuilder>,
    pub(super) cross_section_surface: Option<CrossSectionSurfaceBuilder>,
    pub(super) alignments: Vec<LandXmlAlignment>,
    pub(super) profiles: Vec<LandXmlProfile>,
    pub(super) cross_sections: Vec<LandXmlCrossSection>,
    pub(super) cross_section_surfaces: Vec<LandXmlCrossSectionSurface>,
    pub(super) roadways: Vec<LandXmlRoadway>,
    pub(super) capability_diagnostics: Vec<LandXmlCapabilityDiagnostic>,
    pub(super) preserved_only_extensions: Vec<LandXmlPreservedOnlyExtension>,
    pub(super) active_roadway_source_id: Option<LandXmlSourceId>,
}

impl<'a> Parser<'a> {
    pub(crate) fn new(
        limits: &LandXmlLimits,
        cancelled: Option<&'a dyn LandXmlCancellation>,
    ) -> Self {
        Self {
            limits: limits.clone(),
            cancelled,
            work: 0,
            character_references: 0,
            references: 0,
            surfaces_seen: 0,
            points_seen: 0,
            faces_seen: 0,
            profile_points_seen: 0,
            vertical_curves_seen: 0,
            cross_section_points_seen: 0,
            frames: Vec::new(),
            units: None,
            coordinate_system: None,
            surface: None,
            capture: None,
            surfaces: Vec::new(),
            drained_surface_refs: Vec::new(),
            drained_renderable_surfaces: 0,
            drained_preserved_surfaces: 0,
            extensions: Vec::new(),
            warnings: Vec::new(),
            surface_ordinal: 0,
            version: String::new(),
            root_seen: false,
            root_closed: false,
            alignment: None,
            profile: None,
            cross_section: None,
            cross_section_surface: None,
            alignments: Vec::new(),
            profiles: Vec::new(),
            cross_sections: Vec::new(),
            cross_section_surfaces: Vec::new(),
            roadways: Vec::new(),
            capability_diagnostics: Vec::new(),
            preserved_only_extensions: Vec::new(),
            active_roadway_source_id: None,
        }
    }

    pub(crate) fn take_surfaces(&mut self) -> Vec<LandXmlSurface> {
        let surfaces = std::mem::take(&mut self.surfaces);
        self.drained_renderable_surfaces += surfaces
            .iter()
            .filter(|surface| surface.render_state == LandXmlRenderState::Rendered)
            .count();
        self.drained_preserved_surfaces += surfaces
            .iter()
            .filter(|surface| surface.render_state != LandXmlRenderState::Rendered)
            .count();
        self.drained_surface_refs.extend(
            surfaces
                .iter()
                .map(|surface| (surface.name.clone(), surface.source_id.clone())),
        );
        surfaces
    }

    pub(crate) fn has_open_frames(&self) -> bool {
        !self.frames.is_empty()
    }

    pub(crate) fn header(&self) -> Option<(String, LandXmlUnits)> {
        (!self.version.is_empty() && self.units.is_some()).then(|| {
            (
                self.version.clone(),
                self.units.clone().expect("guarded units"),
            )
        })
    }
}

#[derive(Clone)]
pub(super) struct Frame {
    pub(super) local: String,
    pub(super) target: bool,
    /// One-based among same-name, same-namespace siblings. Source list paths
    /// retain this instead of repeating their leaf name (#5084).
    pub(super) sibling_ordinal: usize,
    pub(super) child_ordinals: HashMap<(bool, String), usize>,
    pub(super) overlay_name: Option<String>,
    pub(super) overlay_kind: Option<String>,
    pub(super) overlay_properties: crate::LandXmlProperties,
    pub(super) namespaces: HashMap<String, String>,
}

#[derive(Clone)]
pub(crate) struct SurfaceBuilder {
    pub(crate) name: String,
    pub(crate) kind: LandXmlSurfaceKind,
    pub(crate) points: Vec<LandXmlPoint>,
    pub(crate) canonical_vertices: Vec<crate::LandXmlCanonicalVertex>,
    pub(crate) source_data_points: Vec<crate::LandXmlSourcePoint>,
    pub(crate) ids: HashSet<String>,
    pub(crate) faces: Vec<[String; 3]>,
    pub(crate) face_visibility: Vec<bool>,
    pub(crate) hidden_face_count: usize,
    pub(crate) boundaries: Vec<LandXmlPolyline>,
    pub(crate) breaklines: Vec<LandXmlPolyline>,
    pub(crate) contours: Vec<LandXmlPolyline>,
    pub(crate) properties: crate::LandXmlProperties,
    pub(crate) definition_properties: crate::LandXmlProperties,
}

pub(super) fn retained_properties(attributes: &Attributes) -> crate::LandXmlProperties {
    attributes
        .iter()
        .filter(|(name, _)| !name.starts_with("xmlns"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}
