/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::{HashMap, HashSet};

use crate::{
    capture::Capture, xml::Attributes, LandXmlAlignment, LandXmlCancellation,
    LandXmlCapabilityDiagnostic, LandXmlCoordinateSystem, LandXmlCrossSection,
    LandXmlCrossSectionSurface, LandXmlExtension, LandXmlLimits, LandXmlPoint, LandXmlPolyline,
    LandXmlPreservedOnlyExtension, LandXmlProfile, LandXmlRoadway, LandXmlSourceId, LandXmlSurface,
    LandXmlSurfaceKind, LandXmlUnits,
};

use super::profiles::{
    AlignmentBuilder, CrossSectionBuilder, CrossSectionSurfaceBuilder, ProfileBuilder,
};

pub(super) struct Parser<'a> {
    pub(super) limits: &'a LandXmlLimits,
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
    pub(super) extensions: Vec<LandXmlExtension>,
    pub(super) warnings: Vec<String>,
    pub(super) schema: String,
    pub(super) target_namespace: Option<String>,
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
