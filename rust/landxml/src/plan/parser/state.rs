/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;

use super::super::{
    LandXmlGeometryKind, LandXmlParcel, LandXmlPlanFeature, LandXmlPlanPoint,
    LandXmlPlanPointLocation,
};
use crate::xml::Attributes;

#[derive(Clone)]
pub(super) struct Frame {
    pub(super) local: String,
    pub(super) target: bool,
    pub(super) namespaces: HashMap<String, String>,
}

pub(super) enum Capture {
    CgPoint {
        attributes: Attributes,
        depth: usize,
        text: String,
    },
    Monument {
        attributes: Attributes,
        depth: usize,
        text: String,
    },
    Point {
        role: String,
        depth: usize,
        pnt_ref: Option<String>,
        text: String,
    },
    PointList {
        depth: usize,
        dimension: usize,
        text: String,
    },
    Title {
        depth: usize,
        text: String,
    },
}
impl Capture {
    pub(super) fn depth(&self) -> usize {
        match self {
            Self::CgPoint { depth, .. }
            | Self::Monument { depth, .. }
            | Self::Point { depth, .. }
            | Self::PointList { depth, .. }
            | Self::Title { depth, .. } => *depth,
        }
    }
}

pub(super) enum Active {
    Feature(LandXmlPlanFeature),
    Parcel(LandXmlParcel),
}

pub(super) struct GeometryBuilder {
    pub(super) kind: LandXmlGeometryKind,
    pub(super) depth: usize,
    pub(super) loop_ordinal: Option<usize>,
    pub(super) properties: super::super::model::LandXmlProperties,
    pub(super) rotation: Option<String>,
    pub(super) radius: Option<f64>,
    pub(super) declared_length: Option<f64>,
    pub(super) start: Option<LandXmlPlanPointLocation>,
    pub(super) end: Option<LandXmlPlanPointLocation>,
    pub(super) center: Option<LandXmlPlanPointLocation>,
    pub(super) pi: Option<LandXmlPlanPointLocation>,
    pub(super) intermediate_points: Vec<LandXmlPlanPoint>,
}

pub(super) fn properties(attributes: &Attributes) -> super::super::model::LandXmlProperties {
    attributes
        .iter()
        .filter(|(name, _)| !name.starts_with("xmlns"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}
