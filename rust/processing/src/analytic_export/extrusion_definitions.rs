// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reusable exact extrusion sources and placed product occurrences.

use std::collections::BTreeMap;
use ifc_lite_geometry::analytic::AnalyticExtrusion;
use serde::Serialize;

use super::definitions::{model_sha256, source_key,
    AnalyticSourceContext, AnalyticSourceKey, SweptDiskInstance};
use super::{extrusion_nominal_quantities, ExtrusionNominalQuantities};

/// One authored extrusion before product or representation-map placement.
/// `source` retains raw IFC file units and separate profile/solid positions.
#[derive(Debug, Clone, Serialize)]
pub struct ExtrusionDefinition {
    pub key: AnalyticSourceKey,
    pub source: AnalyticExtrusion,
    /// Derived from the unplaced source, in squared/cubed IFC file units.
    /// Absent when source parameters or profile geometry are unsupported.
    pub nominal_quantities: Option<ExtrusionNominalQuantities>,
}

impl ExtrusionDefinition {
    pub(super) fn from_source(key: AnalyticSourceKey, source: &AnalyticExtrusion) -> Self {
        Self { key, source: source.clone(),
            nominal_quantities: extrusion_nominal_quantities(source) }
    }
}

/// A use of an extrusion source. `world_from_source` maps its solid-local raw
/// coordinates to absolute IFC Z-up metres. Apply the source's profile and
/// solid Position matrices before this matrix for a profile boundary point.
pub type ExtrusionInstance = SweptDiskInstance;

/// Bounded exact source/occurrence view; never substitutes tessellated loops.
#[derive(Debug, Clone, Serialize)]
pub struct ExtrusionDefinitions {
    pub up_axis: &'static str,
    pub source_units: &'static str,
    pub world_units: &'static str,
    pub coordinate_space: &'static str,
    pub model_sha256: String,
    pub schema: Option<String>,
    pub length_unit_scale: f64,
    pub sources: Vec<ExtrusionDefinition>,
    pub instances: BTreeMap<u32, Vec<ExtrusionInstance>>,
    pub diagnostics: Vec<String>,
}

impl ExtrusionDefinitions {
    pub(super) fn new(content: &[u8], length_unit_scale: f64) -> Self {
        Self { up_axis: "Z", source_units: "ifc_file_length_units", world_units: "m",
            coordinate_space: "absolute_ifc_world", model_sha256: model_sha256(content),
            schema: ifc_lite_core::declared_schema_bounded(content), length_unit_scale,
            sources: Vec::new(), instances: BTreeMap::new(), diagnostics: Vec::new() }
    }

    pub(super) fn key(&self, context: AnalyticSourceContext, solid_id: u32) -> AnalyticSourceKey {
        source_key(&self.model_sha256, self.schema.as_deref(), self.length_unit_scale,
            context, solid_id)
    }
}

pub(super) fn profile_segment_count(source: &AnalyticExtrusion) -> usize {
    source.profile.as_ref().map_or(0, |profile| {
        profile.loops.iter().map(|boundary| boundary.segments.len()).sum()
    })
}
