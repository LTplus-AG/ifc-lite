/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::{HashMap, HashSet};

use crate::{xml::Attributes, LandXmlPoint, LandXmlPolyline, LandXmlSurfaceKind};

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

pub(super) struct SurfaceBuilder {
    pub(super) name: String,
    pub(super) kind: LandXmlSurfaceKind,
    pub(super) points: Vec<LandXmlPoint>,
    pub(super) source_data_points: Vec<crate::LandXmlSourcePoint>,
    pub(super) ids: HashSet<String>,
    pub(super) faces: Vec<[String; 3]>,
    pub(super) face_visibility: Vec<bool>,
    pub(super) hidden_face_count: usize,
    pub(super) boundaries: Vec<LandXmlPolyline>,
    pub(super) breaklines: Vec<LandXmlPolyline>,
    pub(super) contours: Vec<LandXmlPolyline>,
    pub(super) properties: crate::LandXmlProperties,
    pub(super) definition_properties: crate::LandXmlProperties,
}

pub(super) fn retained_properties(attributes: &Attributes) -> crate::LandXmlProperties {
    attributes
        .iter()
        .filter(|(name, _)| !name.starts_with("xmlns"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}
