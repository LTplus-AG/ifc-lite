/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub(crate) enum Capture {
    Point {
        id: String,
        depth: usize,
        text: String,
    },
    Face {
        depth: usize,
        text: String,
        hidden: bool,
    },
    SourcePoints {
        depth: usize,
        text: String,
        source_path: String,
        coordinate_dimension: u8,
    },
    Polyline {
        depth: usize,
        text: String,
        category: PolylineCategory,
        name: Option<String>,
        kind: Option<String>,
        properties: crate::LandXmlProperties,
        source_path: String,
        coordinate_dimension: u8,
    },
    ProfilePoint {
        depth: usize,
        text: String,
        curve: Option<ProfileCurveCapture>,
    },
    PairList {
        depth: usize,
        text: String,
        target: PairListTarget,
    },
    CrossSectionPoint {
        depth: usize,
        text: String,
        point: CrossSectionPointCapture,
    },
}

#[derive(Clone, Copy)]
pub(crate) enum PolylineCategory {
    Boundary,
    Breakline,
    Contour,
}

pub(crate) struct CrossSectionPointCapture {
    pub(crate) data_format: crate::LandXmlCrossSectionPointDataFormat,
    pub(crate) pnt_ref: Option<String>,
    pub(crate) alignment_ref: Option<String>,
    pub(crate) align_ref_station: Option<f64>,
    pub(crate) plan_feature_ref: Option<String>,
    pub(crate) plan_feature_ref_station: Option<f64>,
    pub(crate) parcel_ref: Option<String>,
    pub(crate) parcel_ref_station: Option<f64>,
}

pub(crate) struct ProfileCurveCapture {
    pub(crate) kind: crate::LandXmlVerticalCurveKind,
    pub(crate) length: Option<f64>,
    pub(crate) length_in: Option<f64>,
    pub(crate) length_out: Option<f64>,
    pub(crate) radius: Option<f64>,
}

pub(crate) enum PairListTarget {
    GradeLine,
    CrossSectionSegment,
}

impl Capture {
    pub(crate) fn depth(&self) -> usize {
        match self {
            Self::Point { depth, .. }
            | Self::Face { depth, .. }
            | Self::SourcePoints { depth, .. }
            | Self::Polyline { depth, .. }
            | Self::ProfilePoint { depth, .. }
            | Self::PairList { depth, .. }
            | Self::CrossSectionPoint { depth, .. } => *depth,
        }
    }
}
