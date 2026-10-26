// SPDX-License-Identifier: MPL-2.0
//! Retained candidates from the exact full-pass scheduler; no second classifier.
use super::super::{entity_index::IndexBuilder, scan, ProcessingRequest};
use ifc_lite_core::{IfcType, SourceBundle};

/// Exact full-pass order, excluding type products and representationless jobs.
/// Selection filters apply later so source dependencies remain available.
#[doc(hidden)]
pub fn canonical_element_jobs(source: &SourceBundle) -> Vec<(u32, IfcType)> {
    let mut decoder = source.decoder();
    let mut unused_index = IndexBuilder::new(source.bytes().len(), false);
    scan::scan_entities(
        source.bytes(),
        &ProcessingRequest::full_pass(),
        &mut decoder,
        &mut unused_index,
        false,
    )
    .entity_jobs
    .into_iter()
    .filter(|job| {
        job.representation_map_id.is_none()
            && !job.ifc_type.is_subtype_of(IfcType::IfcTypeProduct)
            && ifc_lite_core::nth_attribute_is_present(&source.bytes()[job.start..job.end], 6)
    })
    .map(|job| (job.id, job.ifc_type))
    .collect()
}
