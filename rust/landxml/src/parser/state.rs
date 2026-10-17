/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};

use crate::{
    capture::Capture, xml::{Attributes, Budget, Meter}, LandXmlAlignment, LandXmlCancellation,
    LandXmlCapabilityDiagnostic, LandXmlCoordinateSystem, LandXmlCrossSection,
    LandXmlCrossSectionSurface, LandXmlExtension, LandXmlLimits, LandXmlPoint, LandXmlPolyline,
    LandXmlPreservedOnlyExtension, LandXmlProfile, LandXmlRenderState, LandXmlRoadway,
    LandXmlSourceId, LandXmlSurface, LandXmlSurfaceKind, LandXmlUnits,
};

use super::profiles::{
    AlignmentBuilder, CrossSectionBuilder, CrossSectionSurfaceBuilder, ProfileBuilder,
};

/// The TIN family's records (a [`crate::xml::FamilyHandler`]). Pull and the
/// stream drive this one handler through the one driver, so they cannot grow
/// parallel LandXML interpretations just because transport arrives in chunks.
pub(crate) struct TinHandler<'a> {
    pub(super) limits: LandXmlLimits,
    pub(super) cancelled: Option<&'a dyn LandXmlCancellation>,
    /// The `work` budget; charged per event in `consume_event` (D73).
    pub(super) meter: Meter<'a>,
    pub(super) references: Budget,
    pub(super) surfaces_seen: Budget,
    pub(super) points_seen: Budget,
    /// Bytes of element paths retained by records (`max_source_path_bytes`).
    pub(super) source_path_bytes: Budget,
    pub(super) coordinate_systems_seen: usize,
    pub(super) faces_seen: Budget,
    pub(super) profile_points_seen: Budget,
    pub(super) vertical_curves_seen: Budget,
    pub(super) cross_section_points_seen: Budget,
    pub(super) capability_diagnostics_seen: Budget,
    pub(super) frames: Vec<Frame>,
    pub(super) units: Option<LandXmlUnits>,
    /// #5175: resolved once at construction from `LandXmlLimits::assumed_linear_unit`,
    /// already validated. A declared `<Units>` element (`self.units`) always
    /// takes priority over this; see `TinHandler::effective_units`.
    pub(super) assumed_units: Option<LandXmlUnits>,
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
    /// #5175: drained surfaces that actually put geometry on screen — the
    /// units gate's subject, narrower than `drained_renderable_surfaces`
    /// because a fully hidden TIN is renderable but draws nothing.
    pub(super) drained_drawing_surfaces: usize,
    pub(super) drained_preserved_surfaces: usize,
    pub(super) extensions: Vec<LandXmlExtension>,
    pub(super) warnings: Vec<String>,
    pub(super) schema: String,
    pub(super) target_namespace: Option<String>,
    pub(super) surface_ordinal: usize,
    pub(super) version: String,
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

impl<'a> TinHandler<'a> {
    pub(crate) fn new(
        limits: &LandXmlLimits,
        meter: Meter<'a>,
        cancelled: Option<&'a dyn LandXmlCancellation>,
        assumed_units: Option<LandXmlUnits>,
    ) -> Self {
        Self {
            limits: limits.clone(),
            cancelled,
            meter,
            references: Budget::new(limits.max_references, "reference"),
            surfaces_seen: Budget::new(limits.max_surfaces, "surface"),
            points_seen: Budget::new(limits.max_points, "point"),
            source_path_bytes: Budget::new(limits.max_source_path_bytes, "retained source path"),
            coordinate_systems_seen: 0,
            faces_seen: Budget::new(limits.max_faces, "face"),
            profile_points_seen: Budget::new(limits.max_profile_points, "profile point"),
            vertical_curves_seen: Budget::new(limits.max_vertical_curves, "vertical curve"),
            cross_section_points_seen: Budget::new(limits.max_cross_section_points, "cross-section point"),
            capability_diagnostics_seen: Budget::new(limits.max_capability_diagnostics, "capability diagnostic"),
            frames: Vec::new(),
            units: None,
            assumed_units,
            coordinate_system: None,
            surface: None,
            capture: None,
            surfaces: Vec::new(),
            drained_surface_refs: Vec::new(),
            drained_renderable_surfaces: 0,
            drained_drawing_surfaces: 0,
            drained_preserved_surfaces: 0,
            extensions: Vec::new(),
            warnings: Vec::new(),
            schema: String::new(),
            target_namespace: None,
            surface_ordinal: 0,
            version: String::new(),
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
        self.drained_drawing_surfaces += surfaces
            .iter()
            .filter(|surface| super::finalize::surface_draws_to_scale(surface))
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

    pub(crate) fn header(&self) -> Option<(String, Option<LandXmlUnits>)> {
        (!self.version.is_empty()).then(|| (self.version.clone(), self.effective_units()))
    }

    /// Whether the source has declared its `<Units>` yet (#7753).
    pub(crate) fn declares_units(&self) -> bool {
        self.units.is_some()
    }

    /// #5175: a declared `<Units>` element always wins; the caller-supplied
    /// assumed unit only fills the gap when the source never declares one.
    pub(super) fn effective_units(&self) -> Option<LandXmlUnits> {
        self.units.clone().or_else(|| self.assumed_units.clone())
    }
}

#[derive(Clone)]
pub(super) struct Frame {
    pub(super) local: Rc<str>,
    pub(super) target: bool,
    /// One-based among same-name, same-namespace siblings. Source list paths
    /// retain this instead of repeating their leaf name (#5084).
    pub(super) sibling_ordinal: usize,
    pub(super) child_ordinals: HashMap<(bool, String), usize>,
    pub(super) overlay_name: Option<String>,
    pub(super) overlay_kind: Option<String>,
    pub(super) overlay_properties: crate::LandXmlProperties,
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
