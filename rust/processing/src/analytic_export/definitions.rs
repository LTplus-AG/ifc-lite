// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reusable authored source geometry and explicit product occurrences.

use std::collections::BTreeMap;
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus, AnalyticSweptDisk};
use serde::Serialize;
use sha2::{Digest, Sha256};
use nalgebra::Matrix4;

/// A context is a top-level representation for a direct solid, or the ordered
/// `IfcRepresentationMap` IDs for a mapped solid. MappingTarget IDs are excluded
/// so occurrences of one map share their source definition.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SweptDiskSourceContext {
    Direct { representation_id: u32 },
    Mapped { representation_map_path: Vec<u32> },
}

/// Stable within and across reads of the same IFC bytes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct SweptDiskSourceKey {
    pub model_sha256: String,
    pub schema: Option<String>,
    pub length_unit_scale_bits: u64,
    pub context: SweptDiskSourceContext,
    pub solid_id: u32,
}

/// Original `IfcSweptDiskSolid` geometry in IFC file length units.
#[derive(Debug, Clone, Serialize)]
pub struct SweptDiskDefinition {
    pub key: SweptDiskSourceKey,
    pub directrix_id: u32,
    #[serde(rename = "Radius")]
    pub radius: f64,
    #[serde(rename = "InnerRadius")]
    pub inner_radius: Option<f64>,
    #[serde(rename = "Directrix")]
    pub directrix: Vec<AnalyticCurveSegment>,
    pub status: AnalyticStatus,
}

/// One use of a source solid. Matrix is column-major f64 and maps raw IFC
/// source coordinates directly to absolute IFC Z-up world metres. It includes
/// model length units, object placement and every enclosing mapping transform.
#[derive(Debug, Clone, Serialize)]
pub struct SweptDiskInstance {
    pub ordinal: usize,
    pub source: SweptDiskSourceKey,
    pub product_id: u32,
    pub solid_id: u32,
    pub mapping_path: Vec<u32>,
    pub source_modified: bool,
    pub world_from_source: Option<[f64; 16]>,
    pub status: AnalyticStatus,
}

/// Bounded source/instance view of authored swept disks.
#[derive(Debug, Clone, Serialize)]
pub struct SweptDiskDefinitions {
    pub up_axis: &'static str,
    pub source_units: &'static str,
    pub world_units: &'static str,
    pub coordinate_space: &'static str,
    pub model_sha256: String,
    pub schema: Option<String>,
    pub length_unit_scale: f64,
    pub sources: Vec<SweptDiskDefinition>,
    pub instances: BTreeMap<u32, Vec<SweptDiskInstance>>,
    pub diagnostics: Vec<String>,
}

impl SweptDiskDefinitions {
    pub(super) fn new(content: &[u8], unit_scale: f64) -> Self {
        let model_sha256 = format!("{:x}", Sha256::digest(content));
        let schema = file_schema(content);
        Self { up_axis: "Z", source_units: "ifc_file_length_units",
            world_units: "m", coordinate_space: "absolute_ifc_world",
            model_sha256, schema, length_unit_scale: unit_scale,
            sources: Vec::new(), instances: BTreeMap::new(), diagnostics: Vec::new() }
    }

    pub(super) fn key(&self, context: SweptDiskSourceContext, solid_id: u32) -> SweptDiskSourceKey {
        SweptDiskSourceKey { model_sha256: self.model_sha256.clone(),
            schema: self.schema.clone(), length_unit_scale_bits: self.length_unit_scale.to_bits(),
            context, solid_id }
    }
}

impl SweptDiskDefinition {
    pub(super) fn from_disk(key: SweptDiskSourceKey, disk: &AnalyticSweptDisk) -> Self {
        Self { key, directrix_id: disk.directrix_id, radius: disk.radius,
            inner_radius: disk.inner_radius, directrix: disk.segments.clone(),
            status: disk.status.clone() }
    }
}

fn file_schema(content: &[u8]) -> Option<String> {
    // FILE_SCHEMA is in the header. A bounded read avoids copying a whole model.
    let header = String::from_utf8_lossy(&content[..content.len().min(65_536)]);
    let at = header.to_ascii_uppercase().find("FILE_SCHEMA")?;
    let suffix = &header[at + "FILE_SCHEMA".len()..];
    let quote = suffix.find('\'')?;
    let rest = &suffix[quote + 1..];
    Some(rest[..rest.find('\'')?].to_string())
}

pub(super) fn source_matrix(transform: &Matrix4<f64>, unit_scale: f64) -> Option<[f64; 16]> {
    if !unit_scale.is_finite() || unit_scale <= 0.0 || transform.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let mut matrix = *transform;
    for column in 0..3 {
        for row in 0..3 { matrix[(row, column)] *= unit_scale; }
    }
    matrix.iter().all(|v| v.is_finite()).then(|| {
        let mut values = [0.0; 16];
        values.copy_from_slice(matrix.as_slice());
        values
    })
}
