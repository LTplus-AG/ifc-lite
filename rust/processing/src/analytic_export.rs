// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Optional analytic descriptions of authored geometry, keyed by product occurrence.
//! This walks the same body-representation selection as the mesh router, but does
//! not produce meshes. Source operands of booleans are identified as such.

use std::collections::{BTreeMap, HashSet};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};

mod transform;
mod metrics;
pub use metrics::{DirectrixMetrics, DirectrixSegmentMetrics};
mod checks;
pub use checks::{check_swept_disk, SweptDiskCheckError, SweptDiskCheckFinding,
    SweptDiskCheckOptions, SweptDiskCheckReport, SweptDiskFindingCode};
mod quantities;
pub use quantities::{extrusion_nominal_quantities, ExtrusionNominalQuantities, SweptDiskNominalQuantities};
mod occurrence;
mod operands;
mod placement;
mod mapped;
mod walk;
mod definitions;
pub use definitions::{AnalyticSourceContext, AnalyticSourceKey, SweptDiskDefinition,
    SweptDiskDefinitions, SweptDiskInstance, SweptDiskSourceKey, SweptDiskSourceContext};
mod extrusion_definitions;
pub use extrusion_definitions::{ExtrusionDefinition, ExtrusionDefinitions, ExtrusionInstance};
use serde::Serialize;

const MAX_VISITED_ITEMS: usize = 100_000;
const MAX_ITEM_DEPTH: usize = 128;

/// One authored `IfcSweptDiskSolid` in an occurrence's body representation.
#[derive(Debug, Clone)]
pub struct SweptDiskOccurrence {
    pub solid_id: u32,
    pub directrix_id: u32,
    pub mapping_path: Vec<u32>,
    /// True when this solid is an operand of an enclosing CSG construction.
    pub source_modified: bool,
    /// Effective world radius for a complete description; source radius in
    /// metres when status is unsupported (no world circular radius is implied).
    pub radius: f64,
    pub inner_radius: Option<f64>,
    pub directrix: Vec<AnalyticCurveSegment>,
    pub status: AnalyticStatus,
}

/// Analytic swept disks in IFC Z-up, absolute-world metres.
#[derive(Debug, Clone, Serialize)]
pub struct SweptDiskDescriptions {
    pub up_axis: &'static str,
    pub units: &'static str,
    pub coordinate_space: &'static str,
    pub elements: BTreeMap<u32, Vec<SweptDiskOccurrence>>,
    pub diagnostics: Vec<String>,
}

impl Default for SweptDiskDescriptions {
    fn default() -> Self {
        Self {
            up_axis: "Z",
            units: "m",
            coordinate_space: "absolute_ifc_world",
            elements: BTreeMap::new(),
            diagnostics: Vec::new(),
        }
    }
}

/// Three analytic source views from one bounded representation walk. This is
/// useful for quantity joins that need exact swept-disk world directrices and
/// reusable disk/extrusion definitions with matching occurrence ordinals.
#[derive(Debug, Clone)]
pub struct AnalyticQuantitySources {
    pub swept_disk_descriptions: SweptDiskDescriptions,
    pub swept_disk_definitions: SweptDiskDefinitions,
    pub extrusion_definitions: ExtrusionDefinitions,
}

/// Extract all quantity source views in one canonical walk. Existing individual
/// APIs keep their output and budget contracts unchanged.
pub fn extract_analytic_quantity_sources(
    content: &[u8], ids: Option<&HashSet<u32>>,
) -> AnalyticQuantitySources {
    let result = walk::extract(content, ids, true, true, true);
    AnalyticQuantitySources {
        swept_disk_descriptions: result.descriptions,
        swept_disk_definitions: result.definitions.expect("definition collection requested"),
        extrusion_definitions: result.extrusions.expect("extrusion collection requested"),
    }
}

/// Extract exact swept-disk definitions for product occurrences, optionally
/// restricted to a set of product STEP IDs. An empty set returns no products.
/// Unsupported directrices are reported in each record's `status`; malformed
/// representation walks are reported in `diagnostics` and omitted atomically
/// for the affected product.
pub fn extract_swept_disk_descriptions(
    content: &[u8], ids: Option<&HashSet<u32>>,
) -> SweptDiskDescriptions {
    walk::extract(content, ids, false, true, false).descriptions
}

/// Opt-in source/instance view. Definitions stay in raw IFC file units;
/// occurrence matrices map those raw coordinates into absolute IFC Z-up metres.
pub fn extract_swept_disk_definitions(
    content: &[u8], ids: Option<&HashSet<u32>>,
) -> SweptDiskDefinitions {
    walk::extract(content, ids, true, false, false).definitions.expect("definition collection requested")
}

/// Opt-in exact source/instance view of `IfcExtrudedAreaSolid` occurrences.
/// Source profiles and depths retain IFC file units; each f64 occurrence
/// matrix maps solid-local source coordinates to absolute IFC Z-up metres.
pub fn extract_extrusion_definitions(
    content: &[u8], ids: Option<&HashSet<u32>>,
) -> ExtrusionDefinitions {
    walk::extract(content, ids, false, false, true)
        .extrusions.expect("extrusion collection requested")
}

/// Return both world descriptions and reusable raw source definitions in one
/// bounded representation walk. Both views share the same decoded source cache.
pub fn extract_swept_disk_views(
    content: &[u8], ids: Option<&HashSet<u32>>,
) -> (SweptDiskDescriptions, SweptDiskDefinitions) {
    let result = walk::extract(content, ids, true, true, false);
    (result.descriptions, result.definitions.expect("definition collection requested"))
}
