/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! State builders for LandXML profile, section, and roadway records.

mod dispatch;
mod finish;
mod start;
mod values;

use crate::{
    LandXmlCrossSectionPoint, LandXmlCrossSectionSegment, LandXmlGradeLine, LandXmlProfileKind,
    LandXmlProfilePoint, LandXmlSourceId, LandXmlVerticalCurve,
};

pub(super) struct AlignmentBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) ordinal: usize,
    pub(super) name: String,
    pub(super) length: f64,
    pub(super) station_start: f64,
    pub(super) profile_source_ids: Vec<LandXmlSourceId>,
    pub(super) cross_section_source_ids: Vec<LandXmlSourceId>,
}

pub(super) struct ProfileBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) parent_alignment_source_id: LandXmlSourceId,
    pub(super) ordinal: usize,
    pub(super) name: String,
    pub(super) kind: LandXmlProfileKind,
    pub(super) pvis: Vec<LandXmlProfilePoint>,
    pub(super) vertical_curves: Vec<LandXmlVerticalCurve>,
    pub(super) grade_lines: Vec<LandXmlGradeLine>,
}

pub(super) struct CrossSectionBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) parent_alignment_source_id: LandXmlSourceId,
    pub(super) ordinal: usize,
    pub(super) station: f64,
    pub(super) surface_source_ids: Vec<LandXmlSourceId>,
}

pub(super) struct CrossSectionSurfaceBuilder {
    pub(super) source_id: LandXmlSourceId,
    pub(super) parent_cross_section_source_id: LandXmlSourceId,
    pub(super) kind: crate::LandXmlCrossSectionSurfaceKind,
    pub(super) name: Option<String>,
    pub(super) segments: Vec<LandXmlCrossSectionSegment>,
    pub(super) points: Vec<LandXmlCrossSectionPoint>,
}
